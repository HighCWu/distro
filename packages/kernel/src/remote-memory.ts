// SPDX-License-Identifier: MIT
// Internal machine/Worker transport, never a user module import or Linux API.
import { read_user_memory, write_user_memory } from "./user-memory.ts";
import type { WasmAddress } from "./wasm.ts";

const PENDING = 0,
  CLAIMED = 1,
  DONE = 2,
  CANCELLED = 3;
const MAX_COPY = 65536;

export type RemoteMemoryOperation =
  | { kind: "register"; id: number; memory: WebAssembly.Memory }
  | { kind: "release"; id: number }
  | { kind: "read" | "write"; id: number; user: WasmAddress; kernel: WasmAddress; length: number };

export interface RemoteMemoryMessage {
  type: "remote_memory";
  operation: RemoteMemoryOperation;
  reply: SharedArrayBuffer;
}

/** One registry per machine. IDs must be assigned once by the kernel and must
 * never wrap/rebind to another mm. Holding a Memory reference also retains an
 * old exec image until its mm has drained its foreign-access references.
 * Main-agent handling is synchronous and never re-enters Linux or user Wasm.
 */
export class RemoteMemoryRegistry {
  private readonly memories = new Map<number, WebAssembly.Memory>();
  private readonly kernel: WebAssembly.Memory;
  private closed = false;

  constructor(kernel: WebAssembly.Memory) {
    this.kernel = kernel;
  }

  handle(message: RemoteMemoryMessage): void {
    if (!(message.reply instanceof SharedArrayBuffer) || message.reply.byteLength !== 8)
      throw new Error("invalid remote memory reply");
    const reply = new Int32Array(message.reply);
    // Claim before dereferencing payload addresses. A requester which wins
    // cancellation can immediately reuse its kernel buffer, even if this
    // message remains queued. No access is allowed after that cancellation.
    if (Atomics.compareExchange(reply, 0, PENDING, CLAIMED) !== PENDING) return;
    let result = -5;
    try {
      result = this.perform(message.operation);
    } catch {
      /* Publish EIO on host errors. */
    }
    Atomics.store(reply, 1, result);
    Atomics.store(reply, 0, DONE);
    // reply is a JS-owned SAB held by this handler, not freed kernel memory.
    Atomics.notify(reply, 0);
  }

  private perform(operation: RemoteMemoryOperation): number {
    if (this.closed) return -3;
    const id = operation.id;
    if (!Number.isInteger(id) || id <= 0 || id > 0x7fffffff) return -22;
    if (operation.kind === "register") {
      if (
        !(operation.memory instanceof WebAssembly.Memory) ||
        !(operation.memory.buffer instanceof SharedArrayBuffer)
      )
        return -95;
      // CLONE_VM Workers may register the same mm. Preserve the original
      // reference: a late duplicate must never replace a published image.
      if (!this.memories.has(id)) this.memories.set(id, operation.memory);
      return 1;
    }
    if (operation.kind === "release") {
      this.memories.delete(id);
      return 0;
    }
    const memory = this.memories.get(id);
    if (!memory) return -3;
    if (!Number.isInteger(operation.length) || operation.length < 0 || operation.length > MAX_COPY)
      return -22;
    let residue: number;
    if (operation.kind === "read")
      residue = read_user_memory(
        this.kernel,
        operation.kernel,
        memory,
        operation.user,
        operation.length,
      );
    else if (operation.kind === "write")
      residue = write_user_memory(
        memory,
        operation.user,
        this.kernel,
        operation.kernel,
        operation.length,
      );
    else return -22;
    return operation.length - residue;
  }

  /** Invoke only after machine Workers have stopped; keep servicing their
   * outstanding requests during teardown so claimed operations can finish. */
  close(): void {
    this.closed = true;
    this.memories.clear();
  }
}

/** Worker-only synchronous request. Cancellation is allowed only before the
 * machine agent claims ownership. Once claimed, the caller retains its kernel
 * buffer until DONE, even if the deadline expires. A scheduling hook can yield
 * the caller's logical CPU between bounded waits when used from sleepable C.
 */
export function request_remote_memory(
  send: (message: RemoteMemoryMessage) => void,
  operation: RemoteMemoryOperation,
  options: { deadlineMs?: number; now?: () => number; yieldKernel?: () => void } = {},
): number {
  let reply: Int32Array<SharedArrayBuffer>;
  try {
    reply = new Int32Array(new SharedArrayBuffer(8));
  } catch {
    return -12;
  }
  // Browser main agents cannot block. Detect that before publishing anything
  // which could retain a kernel buffer, rather than throwing after send().
  try {
    Atomics.wait(reply, 0, PENDING, 0);
  } catch {
    return -95;
  }
  const now = options.now ?? (() => performance.now());
  const deadline = now() + (options.deadlineMs ?? 5000);
  let sendFailed = false;
  let sendError: unknown;
  const cancel_or_join = (error: unknown): never => {
    if (Atomics.compareExchange(reply, 0, PENDING, CANCELLED) !== PENDING)
      while (Atomics.load(reply, 0) !== DONE) Atomics.wait(reply, 0, CLAIMED, 1);
    throw error;
  };
  try {
    send({ type: "remote_memory", operation, reply: reply.buffer });
  } catch (error) {
    // send may have queued the request before an observer threw. If another
    // agent has claimed it, returning now would release live kernel storage.
    if (Atomics.compareExchange(reply, 0, PENDING, CANCELLED) === PENDING) return -5;
    sendFailed = true;
    sendError = error;
  }
  for (;;) {
    const state = Atomics.load(reply, 0);
    if (state === DONE) {
      if (sendFailed) throw sendError;
      return Atomics.load(reply, 1);
    }
    if (state === PENDING) {
      let expired = false;
      try {
        expired = now() >= deadline;
      } catch (error) {
        cancel_or_join(error);
      }
      if (expired && Atomics.compareExchange(reply, 0, PENDING, CANCELLED) === PENDING) return -11;
    }
    Atomics.wait(reply, 0, state, 1);
    if (Atomics.load(reply, 0) === DONE) continue;
    // Never unwind a claimed operation through a diagnostic/scheduler hook.
    // The caller must join it before propagating that hook's original error.
    if (options.yieldKernel) {
      try {
        options.yieldKernel();
      } catch (error) {
        cancel_or_join(error);
      }
    }
  }
}
