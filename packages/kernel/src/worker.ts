// SPDX-License-Identifier: MIT

import { listen_endpoint, post_endpoint } from "./endpoint.ts";
import { create_wasm_halt } from "./kernel-halt.ts";
import { platform } from "./platform.ts";
import { request_remote_memory, type RemoteMemoryMessage } from "./remote-memory.ts";
import {
  create_fork_profile,
  new_fork_profile_request,
  type ForkProfile,
  type ForkProfileRequest,
} from "./fork-profile.ts";
import {
  fork_signal_test,
  fork_resume_signal_test,
  fork_child_signal_test,
  inject_saved_fork_signal,
  inject_resume_fork_signal,
  inject_child_fork_signal,
} from "./fork-signal-test.ts";
import {
  inject_copy_fault,
  type CopyFault,
  copy_status_words,
  pause_copy_publication,
  acknowledge_copy_timeout,
  join_copy_timeout,
  copy_fault_test,
  require_copy_wait_progress,
} from "./copy-fault.ts";
import {
  user_mmap,
  user_mmap_fixed,
  user_mmap_query,
  user_mremap,
  user_mremap_dontunmap,
  user_mremap_fixed,
  user_msync,
  user_madvise,
} from "./user-mmap.ts";
import { FileMmapCopy } from "./file-mmap-copy.ts";
import { apply_fork_memory_advice } from "./fork-memory-advice.ts";
import { user_brk_layout, user_brk_update } from "./user-brk.ts";
import {
  call_user_poll,
  call_user_maintenance,
  user_poll_thread,
  call_fork_child_return,
  fork_child_return_supported,
} from "./user-poll.ts";
import {
  read_signal_stack_pointer,
  call_on_signal_stack,
  call_signal_callback,
  call_kernel_entry,
  call_plain_signal_handler,
  call_user_callback,
} from "./signal-stack.ts";
import { write_exec_image } from "./exec-image.ts";
import {
  ForkContinuation,
  dispatch_fork_syscall,
  dispatch_fork_checkpoint,
  type CloneSyscallLayout,
  fork_continuation_exports_supported,
  uses_fork_continuation,
  resume_fork_parent,
  resume_fork_child,
} from "./fork-continuation.ts";
import {
  settle_user_copy,
  USER_COPY_COMPLETE,
  USER_COPY_NO_MEMORY,
  user_copy_failed,
  type UserCopyStatus,
  wait_user_copy,
} from "./user-copy.ts";
import { assert } from "./util.ts";
import {
  read_user_memory,
  write_user_memory,
  clear_user_memory,
  user_atomic_word,
} from "./user-memory.ts";
import {
  read_wasm_memories,
  user_memory_import,
  read_wasm_main_table,
  read_wasm_dynamic_signatures,
  user_poll_globals_supported,
  type WasmGlobalImport,
} from "./wasm_binary.ts";
import { ProcessDylink } from "./dylink_process.ts";
import { DylinkWorkerRuntime } from "./dylink_worker_runtime.ts";
import {
  DylinkWorkerChannel,
  DylinkWorkerChannelError,
  type DylinkWorkerAdmissionToken,
  type DylinkWorkerChannelResult,
} from "./dylink_worker_channel.ts";
import {
  DylinkWorkerSnapshotError,
  prepare_dylink_worker_snapshot,
  validate_dylink_worker_snapshot,
  type DylinkWorkerSnapshot,
} from "./dylink_process_worker.ts";
import { prepare_dylink_call_metadata } from "./dylink_call_metadata.ts";
import { DynamicVforkState, dynamic_vfork_allowed } from "./dynamic-vfork.ts";
import {
  DYNAMIC_LOADER_CLAIMED,
  claim_dynamic_loader,
  create_dynamic_process_state,
  dynamic_process_has_replay,
  dynamic_process_value,
  dynamic_thread_clone_allowed,
  publish_dynamic_replay_ready,
  release_dynamic_loader_claim,
  restore_dynamic_table,
  run_dynamic_thread_clone,
  snapshot_dynamic_table,
} from "./dynamic-thread.ts";
import { encode_linux_string } from "./linux-string.ts";
import { user_function_imports_supported } from "./user-functions.ts";
import {
  allocate_shared_memory,
  HALT_KERNEL,
  type Imports,
  type Instance,
  kernel_imports,
  user_context_imports,
  MachineTerminationReason,
  memory_bytes,
  refresh_memory,
  refresh_memory_range,
  user_module_imports_supported,
  type WasmAddress,
  type WasmAddressType,
  wasm_pointer_to_number,
  wasm_address_from_number,
  wasm_size_to_number,
  wasm_table_get,
  type UserContext,
} from "./wasm.ts";

export interface InitMessage {
  type: "init";
  fn: WasmAddress;
  arg: WasmAddress;
  vmlinux: WebAssembly.Module;
  memory: WebAssembly.Memory;
  kernel_address: WasmAddressType;
  user: UserContext | null;
  /** One-shot COPY or shared-Worker preparation result: 0 pending, 1 complete, negative errno. */
  user_copy_status: UserCopyStatus | null;
  /** Wait until a shared-memory callback Worker has reconstructed dynamic state. */
  shared_user_prepare?: boolean;
  copy_fault?: CopyFault;
  fork_profile?: ForkProfileRequest;
}
export interface ForwardedInitMessage {
  type: "forwarded_init";
  port: MessagePort;
  user_copy_status: UserCopyStatus | null;
  shared_user_prepare?: boolean;
  copy_fault?: CopyFault;
  fork_profile?: ForkProfileRequest;
}
interface AbortWorkerInitMessage {
  type: "abort_init";
}
export type WorkerMessage =
  | RemoteMemoryMessage
  | {
      type: "spawn_worker";
      name: string;
      port: MessagePort;
      user_copy_status: UserCopyStatus | null;
      shared_user_prepare?: boolean;
      fork_profile?: ForkProfileRequest;
    }
  | { type: "boot_console_write"; message: ArrayBuffer }
  | { type: "fork_profile_started" }
  | { type: "fork_profile_online" | "fork_profile_main_turn" }
  | { type: "fork_profile_module_ready"; module_ns: number }
  | { type: "fork_profile_init_posted"; queued_ns: number; post_ns: number }
  | { type: "fork_profile_record"; line: string }
  | { type: "boot_console_close" }
  | { type: "terminate_machine"; reason: MachineTerminationReason }
  | { type: "run_on_main"; fn: WasmAddress; arg: WasmAddress }
  | { type: "worker_exit" };

const unavailable = () => {
  throw new Error("not available on worker thread");
};

const endpoint = platform.worker_endpoint();
const postMessage = (message: WorkerMessage, transfer?: Transferable[]) =>
  post_endpoint(endpoint, message, transfer);
const profile_output = (line: string) => postMessage({ type: "fork_profile_record", line });

type WorkerMembership = NonNullable<NonNullable<UserContext["dynamic"]>["worker_membership"]>;

const WORKER_CHANNEL_CAPACITY = 64 * 1024 * 1024;
const WORKER_CHANNEL_MAX_PARTICIPANTS = 4096;
const MEMBERSHIP_RETIRE_TIMEOUT_MS = 30_000;
const ESTALE = -116;
const EBUSY = -16;
let membership_retirement_wait: Int32Array<SharedArrayBuffer> | null = null;
// A future receiver/coordinator service can finish a publication while this
// Worker is leaving. It must only run protocol work and must never call guest code.
let service_worker_membership: (() => void) | undefined;
let service_worker_checkpoint: (() => number) | undefined;

function retry_busy_channel_operation<T>(
  operation: () => DylinkWorkerChannelResult<T>,
  waitStatus: UserCopyStatus,
): DylinkWorkerChannelResult<T> {
  let result = operation();
  for (let attempt = 0; !result.ok && result.errno === EBUSY && attempt < 100; attempt++) {
    // Membership operations hold the shared spin lock only for a few atomic
    // stores. Yield briefly so another Worker can finish its operation.
    try {
      Atomics.wait(waitStatus, 0, Atomics.load(waitStatus, 0), 1);
    } catch {
      // The retry remains bounded in runtimes which disallow Atomics.wait.
    }
    result = operation();
  }
  return result;
}

let active_worker_membership: WorkerMembership | null = null;

function retire_worker_membership(membership: WorkerMembership): number {
  try {
    const channel = DylinkWorkerChannel.attach(membership.shared);
    const deadline = performance.now() + MEMBERSHIP_RETIRE_TIMEOUT_MS;
    for (;;) {
      const cancelled = channel.cancelAdmission(membership.participant);
      if (cancelled.ok) return 0;
      if (cancelled.errno !== ESTALE && cancelled.errno !== EBUSY) return cancelled.errno;

      // A stale admission token may already be live. unregister() also permits
      // non-cohort peers to exit during the owner's resumable cleanup lease.
      if (cancelled.errno === ESTALE) {
        const removed = channel.unregister(membership.participant);
        if (removed.ok || removed.errno === ESTALE) return 0;
        if (removed.errno !== EBUSY) return removed.errno;
      }
      if (performance.now() >= deadline) return EBUSY;

      // The service drives receiver/protocol phases without resuming user code.
      // Once the publication finishes, a later iteration can unregister safely.
      service_worker_membership?.();
      try {
        membership_retirement_wait ??= new Int32Array(new SharedArrayBuffer(4));
        Atomics.wait(membership_retirement_wait, 0, 0, 1);
      } catch {
        // Keep the retirement deadline bounded if synchronous waiting is absent.
      }
    }
  } catch (error) {
    console.error("could not retire dynamic Worker membership:", error);
    return -5;
  }
}

function cleanup_active_worker_membership(): number {
  const membership = active_worker_membership;
  if (!membership) {
    service_worker_membership = undefined;
    service_worker_checkpoint = undefined;
    return 0;
  }
  const error = retire_worker_membership(membership);
  if (error) {
    console.error(
      `dynamic Worker membership could not be retired while its channel is busy (${error})`,
    );
    return error;
  }
  if (active_worker_membership === membership) active_worker_membership = null;
  service_worker_membership = undefined;
  service_worker_checkpoint = undefined;
  return 0;
}

function terminate_for_membership_retirement(error: number): void {
  if (!error) return;
  console.error("terminating the machine to avoid a stale dynamic Worker cohort");
  try {
    postMessage({ type: "terminate_machine", reason: MachineTerminationReason.Panic });
  } catch (postError) {
    console.error("could not report dynamic Worker retirement failure:", postError);
  } finally {
    // The process is terminating; do not retry this token from a later halt or
    // HALT_KERNEL unwind after reporting the same fatal condition.
    active_worker_membership = null;
    service_worker_membership = undefined;
    service_worker_checkpoint = undefined;
  }
}

function without_worker_membership(user: UserContext | null): UserContext | null {
  if (!user?.dynamic?.worker_membership) return user;
  const { worker_membership: _membership, ...dynamic } = user.dynamic;
  return { ...user, dynamic };
}

const stop_worker = () => {
  try {
    terminate_for_membership_retirement(cleanup_active_worker_membership());
    service_worker_membership = undefined;
    postMessage({ type: "worker_exit" });
  } finally {
    platform.quit();
  }
};

function user_imports({
  kernel_memory,
  kernel_address,
  get_kernel_instance,
  parent_user: parent,
  profile,
}: {
  kernel_memory: WebAssembly.Memory;
  kernel_address: WasmAddressType;
  get_kernel_instance: () => Instance;
  parent_user: UserContext | null;
  profile?: ForkProfile;
}): {
  context: UserContext | null;
  workerCheckpoint(): number;
  prepare(): void;
  applyForkAdvice(): void;
  imports: Imports["user"];
  imports_v2: Imports["user_v2"];
  imports_signal_v1: Imports["user_signal_v1"];
  imports_mmap_init_v1: Imports["user_mmap_init_v1"];
  imports_mmap_stream_v1: Imports["user_mmap_stream_v1"];
  imports_fork_v1: Imports["user_fork_v1"];
  imports_brk_v1: Imports["user_brk_v1"];
  imports_mmap_query_v1: Imports["user_mmap_query_v1"];
} {
  const HALT_USER = create_wasm_halt();

  let context: UserContext | null = parent;
  let instance: WebAssembly.Instance | null = null;
  const poll_threads = new WeakMap<WebAssembly.Instance, ReturnType<typeof user_poll_thread>>();
  let pending_module_bytes: Uint8Array<ArrayBuffer> | null = null;
  let pending: UserContext | null = null;
  let fork: ForkContinuation | null = null;
  let signal_depth = 0;
  const dynamic_vfork = new DynamicVforkState();
  // One slot per nested SA_SIGINFO callback; null means its trampoline has
  // not requested the active signal payload yet.
  const siginfo_copy_results: (number | null)[] = [];
  const mmap_copy = new FileMmapCopy(
    kernel_memory,
    kernel_address,
    () => get_kernel_instance().exports,
  );

  function write_kernel_u32(addr: WasmAddress, value: number): boolean {
    let bytes;
    try {
      refresh_memory_range(kernel_memory, addr, Uint32Array.BYTES_PER_ELEMENT);
      bytes = memory_bytes(
        kernel_memory,
        wasm_pointer_to_number(addr),
        Uint32Array.BYTES_PER_ELEMENT,
      );
    } catch {
      return false;
    }
    if (!bytes) return false;

    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(0, value, true);
    return true;
  }

  function call_start(): void {
    assert(instance);
    const { _start } = instance.exports;
    assert(typeof _start === "function", "_start not found");
    _start();
    if (fork?.unwinding()) return;
    throw new Error("_start reached the end without exiting");
  }
  let call_entry = call_start;
  let thread_entry: typeof call_start | undefined;

  function kernel_leaf<T>(invoke: () => T): T {
    return call_kernel_entry(get_kernel_instance().exports, kernel_address, invoke, true);
  }

  let registered_memory: WebAssembly.Memory | undefined;
  let registered_id = 0;
  function register_remote_memory(): void {
    if (!context) return;
    const exports = get_kernel_instance().exports;
    if (!exports.current_remote_memory_id || !exports.remote_memory_ready) return;
    // During exec, task->mm may precede the JS context swap. The kernel's
    // context_mm check must succeed before associating this Memory with it.
    const id = kernel_leaf(() => exports.current_remote_memory_id!());
    if (!id || (registered_id === id && registered_memory === context.memory)) return;
    if (request_remote_memory(postMessage, { kind: "register", id, memory: context.memory }) !== 1)
      return; // Retain the cooperative kernel route if registration failed.
    if (kernel_leaf(() => exports.remote_memory_ready!(id)) !== 0) return;
    registered_id = id;
    registered_memory = context.memory;
  }

  function user_callback<T>(invoke: () => T): T {
    register_remote_memory();
    const run = () => call_user_callback(get_kernel_instance().exports, kernel_address, invoke);
    const thread = instance ? poll_threads.get(instance) : undefined;
    return thread ? thread.suspend(run) : run();
  }

  function create_instance(context: UserContext): WebAssembly.Instance {
    const kernel_instance = get_kernel_instance();
    const poll2 = WebAssembly.Module.imports(context.module).some(
      (entry) => entry.module === "linux_user_poll_v2",
    );
    const poll_thread = poll2
      ? user_poll_thread(context.address, () =>
          kernel_leaf(() => kernel_instance.exports.get_thread_area()),
        )
      : undefined;
    let created: WebAssembly.Instance;
    let maintenanceReady = false;
    let dynamic: ProcessDylink | undefined;
    let dynamicOperationDepth = 0;
    let workerRuntime: DylinkWorkerRuntime | null = null;
    let workerRuntimeProcess: ProcessDylink | null = null;
    let workerRuntimeMembership: WorkerMembership | null = null;
    const workerPause = () => {
      try {
        membership_retirement_wait ??= new Int32Array(new SharedArrayBuffer(4));
        const wait = membership_retirement_wait;
        Atomics.wait(wait, 0, Atomics.load(wait, 0), 1);
      } catch {
        // Some worker hosts disallow Atomics.wait; checkpoint retry remains bounded.
      }
      // A writer may spend many bounded pauses inside a loader operation, so
      // compiler polling cannot provide kernel maintenance while JS waits.
      // Do not touch `created` until construction and ABI validation finish.
      if (!maintenanceReady || !context) return;
      if (fork && !fork.userPollAllowed(signal_depth !== 0)) return;
      const before = instance;
      const invoke = () => call_user_maintenance(kernel_instance.exports, kernel_address, true);
      if (fork) fork.kernelCall(invoke);
      else invoke();
      if (instance !== before) {
        call_entry = call_start;
        throw HALT_USER;
      }
    };

    const same_worker_membership = (
      left: WorkerMembership | null,
      right: WorkerMembership,
    ): boolean =>
      left?.shared === right.shared &&
      left.participant.slot === right.participant.slot &&
      left.participant.epoch === right.participant.epoch;

    const current_worker_runtime = (
      process: ProcessDylink | undefined = dynamic,
    ): DylinkWorkerRuntime | null => {
      const dynamicContext = context.dynamic;
      const membership = dynamicContext?.worker_membership;
      const notify = kernel_instance.exports.worker_execution_notify_v1;
      if (
        !process ||
        process !== dynamic ||
        !dynamicContext ||
        !membership ||
        !dynamic_process_has_replay(dynamicContext.process_state) ||
        typeof notify !== "function"
      ) {
        return null;
      }

      if (
        workerRuntime &&
        workerRuntimeProcess === process &&
        workerRuntimeMembership &&
        same_worker_membership(workerRuntimeMembership, membership)
      )
        return workerRuntime;

      const runtime = new DylinkWorkerRuntime({
        shared: membership.shared,
        participant: membership.participant,
        process,
        fatal(error) {
          console.error("dynamic Worker checkpoint failed:", error);
          try {
            postMessage({ type: "terminate_machine", reason: MachineTerminationReason.Panic });
          } finally {
            throw HALT_KERNEL;
          }
        },
        notify: () => notify(),
        pause: workerPause,
      });
      workerRuntime = runtime;
      workerRuntimeProcess = process;
      workerRuntimeMembership = membership;
      active_worker_membership = membership;
      return runtime;
    };

    const service_worker_checkpoint_at_boundary = (): number => {
      const runtime = current_worker_runtime();
      if (!runtime) return 0;
      if (signal_depth !== 0 || dynamicOperationDepth !== 0 || dynamic_vfork.blocked(context))
        return 1;
      runtime.checkpoint();
      // Advertise the source, not only observed work: a publication can race
      // this callback before the kernel enters its bounded wait.
      return 1;
    };

    service_worker_checkpoint = service_worker_checkpoint_at_boundary;
    service_worker_membership = () => {
      service_worker_checkpoint?.();
    };

    const dynamic_operation = <T>(invoke: () => T): T => {
      service_worker_checkpoint_at_boundary();
      dynamicOperationDepth++;
      let result: T;
      try {
        result = invoke();
      } finally {
        dynamicOperationDepth--;
      }
      if (dynamicOperationDepth === 0 && maintenanceReady && signal_depth === 0 && created)
        checkpoint();
      return result;
    };
    const control = (error: unknown) => error === HALT_KERNEL || error === HALT_USER;
    let dynamicError = "Dynamic loader failure";
    const dynamicBlocked = (): boolean => {
      if (dynamic_vfork.blocked(context)) {
        dynamicError = "dynamic loading is disabled while a vfork child is active";
        return true;
      }
      const state = dynamic_process_value(context?.dynamic?.process_state);
      if (state === null || (state >= 0 && state !== 0)) {
        dynamicError = "dynamic loading is disabled after thread creation";
        return true;
      }
      return false;
    };
    const write_dynamic_error = (pointer: WasmAddress, sizeValue: WasmAddress): number => {
      try {
        const size = wasm_size_to_number(sizeValue);
        const bytes = memory_bytes(context!.memory, pointer, size);
        if (!bytes) return -14;
        if (size) {
          const message = encode_linux_string(dynamicError);
          const count = Math.min(message.length, size - 1);
          bytes.set(message.subarray(0, count));
          bytes[count] = 0;
        }
        return 0;
      } catch {
        return -14;
      }
    };
    const file_kernel = (invoke: () => number): number => {
      try {
        return kernel_leaf(invoke);
      } catch (error) {
        if (control(error)) throw error;
        console.error("kernel dynamic file-reference failure:", error);
        postMessage({ type: "terminate_machine", reason: MachineTerminationReason.Panic });
        throw HALT_KERNEL;
      }
    };
    const fatal = (error: unknown): never => {
      console.error("unrecoverable dynamic initialization:", error);
      const word = (value: number) => wasm_address_from_number(value, kernel_address);
      kernel_leaf(() =>
        kernel_instance.exports.syscall(
          word(93),
          word(127),
          word(0),
          word(0),
          word(0),
          word(0),
          word(0),
        ),
      );
      throw new Error("dynamic process exit returned");
    };
    const create_dynamic_process = (replay?: DylinkWorkerSnapshot) => {
      if (!context?.dynamic || !created) throw new Error("dynamic main is not ready");
      const blocked = () => {
        const state = dynamic_process_value(context?.dynamic?.process_state);
        return dynamic_vfork.blocked(context) || (state !== null && state >= 0 && state !== 0);
      };
      let process!: ProcessDylink;
      process = new ProcessDylink({
        main: created,
        memory: context.memory,
        address: context.address,
        maximumPages: context.maximum_pages,
        tableType: context.dynamic.table,
        signatures: context.dynamic.signatures,
        functionMetadata: context.dynamic.functionMetadata,
        tagSignatures: context.dynamic.tagSignatures,
        privateExports: context.dynamic.privateExports,
        userPoll:
          poll2 && poll_thread ? { checkpoint, threadPointer: poll_thread.global } : undefined,
        ...(replay ? { replay } : {}),
        ...(replay && context.dynamic.worker_publication
          ? { workerPublicationState: { ...context.dynamic.worker_publication, snapshot: replay } }
          : {}),
        blocked,
        queryBlocked: () => dynamic_vfork.blocked(context),
        beforeInitializeActive: () => current_worker_runtime(process) !== null,
        beforeInitialize: (snapshot, ownerRollback) => {
          current_worker_runtime(process)?.beforeInitialize(snapshot, ownerRollback);
        },
        postThread: () => {
          const state = dynamic_process_value(context?.dynamic?.process_state);
          return state !== null && state >= 0 && state !== 0;
        },
        isControlFlow: control,
        pinFile: (fd, device, inode) =>
          file_kernel(() => kernel_instance.exports.dynamic_file_pin_v1!(fd, device, inode)),
        unpinFile: (id) => file_kernel(() => kernel_instance.exports.dynamic_file_unpin_v1!(id)),
        fatal,
      });
      return process;
    };
    const loader = () => {
      try {
        if (!context.dynamic || !created) throw new Error("dynamic main is not ready");
        if (dynamic) {
          // A replay-unsupported first-thread attempt can retain this valid
          // ProcessDylink while releasing its temporary claim so the legacy
          // clone path remains available. Reclaim before a later dlopen so a
          // clone cannot race a graph mutation.
          if (
            dynamic_process_value(context.dynamic.process_state) === 0 &&
            !claim_dynamic_loader(context.dynamic.process_state)
          ) {
            dynamicError = "dynamic loader initialization is already in progress";
            return null;
          }
          return dynamic;
        }
        if (dynamicBlocked() || !claim_dynamic_loader(context.dynamic.process_state)) {
          if (dynamicError === "Dynamic loader failure")
            dynamicError = "dynamic loader initialization is already in progress";
          return null;
        }
        dynamic = create_dynamic_process();
        return dynamic;
      } catch (error) {
        if (control(error)) throw error;
        return fatal(error);
      }
    };
    const snapshot_error_errno = (error: unknown): number => {
      if (error instanceof DylinkWorkerSnapshotError) {
        if (error.code === "ENOMEM") return 12;
        if (error.code === "EINVAL") return 22;
        return 95;
      }
      if (error instanceof DylinkWorkerChannelError) return Math.abs(error.errno);
      console.error("dynamic Worker graph snapshot failed:", error);
      return 5; // EIO: preserve an actionable diagnostic without admitting a child.
    };
    const prepare_dynamic_thread_snapshot = (): number => {
      let state = dynamic_process_value(context?.dynamic?.process_state);
      if (!context?.dynamic || state === null) return 95;

      let ownsInitialLoaderClaim = false;
      if (state === 0 && typeof kernel_instance.exports.worker_execution_notify_v1 === "function") {
        if (claim_dynamic_loader(context.dynamic.process_state)) {
          ownsInitialLoaderClaim = true;
          if (!dynamic) {
            const table = created.exports.__indirect_function_table;
            if (!(table instanceof WebAssembly.Table)) {
              if (!release_dynamic_loader_claim(context.dynamic.process_state)) return 95;
              return 0;
            }

            // ProcessDylink's constructor settles wrappers into the main
            // function table but does not grow a table or write guest memory.
            // Keep the original slots so a constructor failure can restore
            // the pristine no-loader thread path.
            let originalTableSnapshot: ReturnType<typeof snapshot_dynamic_table>;
            try {
              originalTableSnapshot = snapshot_dynamic_table(table, context.dynamic.table.address);
            } catch (error) {
              const released = release_dynamic_loader_claim(context.dynamic.process_state);
              if (control(error)) throw error;
              return released ? 0 : 95;
            }

            const restoreInitialTable = () =>
              restore_dynamic_table(table, context.dynamic!.table.address, originalTableSnapshot);

            dynamicOperationDepth++;
            try {
              dynamic = create_dynamic_process();
            } catch (error) {
              try {
                restoreInitialTable();
              } catch (restoreError) {
                return fatal(
                  new Error("could not restore the main table after loader initialization", {
                    cause: restoreError,
                  }),
                );
              } finally {
                dynamicOperationDepth--;
              }
              const released = release_dynamic_loader_claim(context.dynamic.process_state);
              if (control(error)) throw error;
              return released ? 0 : 95;
            }
            dynamicOperationDepth--;
          }
          state = DYNAMIC_LOADER_CLAIMED;
        } else {
          // If another operation completed or rolled back while this request
          // was reaching the claim, preserve the normal no-replay clone path.
          state = dynamic_process_value(context.dynamic.process_state);
          if (state === null) return 95;
          if (state >= 0) return 0;
          return 95;
        }
      }

      if (state === DYNAMIC_LOADER_CLAIMED) {
        // A claimed loader with no ProcessDylink object is still initializing.
        // The clone gate must not publish a partially constructed graph.
        if (!dynamic) return 95;
        dynamicOperationDepth++;
        try {
          dynamic.discardWorkerPublicationBeforeThreads();
          const publication = dynamic.initializeWorkerPublication(crypto.randomUUID());

          const previousMembership = context.dynamic.worker_membership;
          if (previousMembership) {
            const retireError = retire_worker_membership(previousMembership);
            if (retireError) return -retireError;
            if (active_worker_membership === previousMembership) active_worker_membership = null;
          }

          const channel = new DylinkWorkerChannel(
            WORKER_CHANNEL_CAPACITY,
            WORKER_CHANNEL_MAX_PARTICIPANTS,
          );
          const registered = channel.register();
          if (!registered.ok) return -registered.errno;
          const membership: WorkerMembership = {
            shared: channel.shared,
            participant: registered.value,
          };

          context.dynamic.worker_snapshot = publication.snapshot;
          context.dynamic.worker_publication = {
            processIdentity: publication.processIdentity,
            generation: publication.generation,
          };
          context.dynamic.worker_membership = membership;
          active_worker_membership = membership;
        } catch (error) {
          if (
            ownsInitialLoaderClaim &&
            error instanceof DylinkWorkerSnapshotError &&
            error.code === "EOPNOTSUPP"
          ) {
            try {
              dynamic.discardWorkerPublicationBeforeThreads();
            } catch (discardError) {
              return snapshot_error_errno(discardError);
            }
            return release_dynamic_loader_claim(context.dynamic.process_state) ? 0 : 95;
          }
          return snapshot_error_errno(error);
        } finally {
          dynamicOperationDepth--;
        }
        return publish_dynamic_replay_ready(context.dynamic.process_state) ? 0 : 95;
      }

      if (dynamic_process_has_replay(context.dynamic.process_state)) {
        if (
          context.dynamic.worker_snapshot === undefined ||
          context.dynamic.worker_membership === undefined
        )
          return 95;
        try {
          validate_dylink_worker_snapshot(context.dynamic.worker_snapshot);
        } catch (error) {
          return snapshot_error_errno(error);
        }
        return 0;
      }

      // Any nonnegative state without REPLAY_READY means the loader never
      // claimed a graph. This includes a sibling's in-flight first clone, so
      // nested callback creation does not race its success-bit publication.
      if (state >= 0) return 0;
      return 95;
    };
    const syscall =
      (layout: CloneSyscallLayout) =>
      (
        nr: WasmAddress,
        arg0: WasmAddress,
        arg1: WasmAddress,
        arg2: WasmAddress,
        arg3: WasmAddress,
        arg4: WasmAddress,
        arg5: WasmAddress,
      ) => {
        service_worker_checkpoint_at_boundary();
        const strict = kernel_instance.exports.seccomp_strict_v1?.() === 1;
        const clone = nr === 220 || nr === 220n;
        const clone3 = nr === 435 || nr === 435n;
        const dynamicVfork =
          Boolean(context.dynamic) &&
          !strict &&
          clone &&
          dynamic_vfork_allowed({
            context,
            loaderCreated:
              dynamic !== undefined || dynamic_process_value(context?.dynamic?.process_state) !== 0,
            layout,
            number: nr,
            args: [arg0, arg1, arg2, arg3, arg4, arg5],
            signalDepth: signal_depth,
            callEntryIsStart: call_entry === call_start,
            dynamicOperationDepth,
            pending: dynamic_vfork.pending,
          });
        const dynamicThread =
          Boolean(context.dynamic) &&
          !strict &&
          !dynamicVfork &&
          dynamic_thread_clone_allowed({
            context,
            layout,
            number: nr,
            args: [arg0, arg1, arg2, arg3, arg4, arg5],
            signalDepth: signal_depth,
            callEntryIsNormal: call_entry === call_start || call_entry === thread_entry,
            dynamicOperationDepth,
            vforkPending: dynamic_vfork.pending,
            sharedMemory:
              typeof SharedArrayBuffer !== "undefined" &&
              context.memory.buffer instanceof SharedArrayBuffer,
          });
        if (dynamicThread) {
          const error = prepare_dynamic_thread_snapshot();
          if (error) return kernel_address === "i64" ? -BigInt(error) : -error;
        }
        // Strict seccomp always reaches the actual kernel entry first. Outside
        // strict mode, dynamic images admit only the selected callback vfork
        // and shared pthread clone shapes.
        if (context.dynamic && !strict && (clone || clone3) && !dynamicVfork && !dynamicThread)
          return kernel_address === "i64" ? -95n : -95;
        const original_instance = instance;
        const kernelInvoke = () =>
          call_kernel_entry(kernel_instance.exports, kernel_address, () =>
            kernel_instance.exports.syscall(nr, arg0, arg1, arg2, arg3, arg4, arg5),
          );
        const invoke = () => {
          if (dynamicVfork) return dynamic_vfork.run(kernelInvoke);
          if (dynamicThread)
            return run_dynamic_thread_clone(
              context?.dynamic?.process_state,
              kernel_address,
              kernelInvoke,
            );
          return kernelInvoke();
        };
        const ret = dispatch_fork_syscall(
          fork,
          nr,
          [arg0, arg1, arg2, arg3, arg4, arg5],
          signal_depth === 0 && call_entry === call_start,
          invoke,
          layout,
          strict,
        );
        if (instance !== original_instance) {
          call_entry = call_start;
          throw HALT_USER;
        }
        // Publish after TLS installation or clone's pre-callback gettid return.
        // Other startup syscalls may still see the old exec image's TP.
        // Always read the kernel value, never a possibly rejected argument.
        if (nr === 244 || nr === 244n || nr === 178 || nr === 178n) poll_thread?.refresh();
        service_worker_checkpoint_at_boundary();
        return ret;
      };
    const checkpoint = () => {
      if (!created) return -95;
      if (fork && !fork.userPollAllowed(signal_depth !== 0)) return 0;
      service_worker_checkpoint_at_boundary();
      const before = instance;
      const invoke = () =>
        call_user_poll(
          kernel_instance.exports,
          created.exports,
          context.memory,
          kernel_address,
          dynamicOperationDepth !== 0,
          signal_depth !== 0,
        );
      const result = fork ? fork.kernelCall(invoke) : invoke();
      if (instance !== before) {
        call_entry = call_start;
        throw HALT_USER;
      }
      return result;
    };
    created = new WebAssembly.Instance(context.module, {
      linux_user_poll_v1: { checkpoint },
      ...(poll_thread
        ? { linux_user_poll_v2: { checkpoint, thread_pointer: poll_thread.global } }
        : {}),
      linux_dlopen_v1: {
        abi: () => 1,
        link_map_abi: () => 1,
        open: (path: WasmAddress, flags: number) =>
          dynamic_operation(() => {
            const runtime = current_worker_runtime();
            if (runtime && signal_depth === 0 && !dynamic_vfork.blocked(context))
              return runtime.open(path, flags);
            return loader()?.open(path, flags) ?? wasm_address_from_number(0, kernel_address);
          }),
        symbol: (handle: WasmAddress, name: WasmAddress) =>
          dynamic_operation(
            () => loader()?.symbol(handle, name) ?? wasm_address_from_number(0, kernel_address),
          ),
        address: (pointer: WasmAddress, info: WasmAddress) =>
          dynamic_operation(() => loader()?.address(pointer, info) ?? 0),
        valid: (handle: WasmAddress) =>
          dynamic_operation(() => {
            if (dynamic) return dynamic.valid(handle);
            if (!dynamicBlocked()) dynamicError = "Invalid dynamic library handle";
            return 0;
          }),
        error: (pointer: WasmAddress, size: WasmAddress) =>
          dynamic_operation(() => {
            if (dynamic) return dynamic.error(pointer, size);
            dynamicBlocked();
            return context ? write_dynamic_error(pointer, size) : -14;
          }),
      },
      env: { memory: context.memory },
      linux_fork_v1: {
        checkpoint: (descriptor: WasmAddress) => {
          const word = (n: number): WasmAddress => (kernel_address === "i64" ? BigInt(n) : n);
          return dispatch_fork_checkpoint(
            fork,
            descriptor,
            signal_depth === 0 && call_entry === call_start,
            () =>
              call_kernel_entry(kernel_instance.exports, kernel_address, () =>
                kernel_instance.exports.syscall(
                  word(220),
                  word(0),
                  word(0),
                  word(17),
                  word(0),
                  word(0),
                  word(0),
                ),
              ),
            kernel_instance.exports.seccomp_strict_v1?.() === 1,
          );
        },
      },
      linux_mmap_init_v1: {
        copy: (to: WasmAddress, length: WasmAddress) => mmap_copy.copy(context.memory, to, length),
      },
      linux: {
        syscall: syscall("callback-v1"),
        syscall_v2: syscall("flags-v2"),
        get_thread_area: () => {
          const invoke = () => kernel_leaf(() => kernel_instance.exports.get_thread_area());
          const value = fork ? fork.kernelCall(invoke) : invoke();
          poll_thread?.publish(value);
          return value;
        },
        copy_siginfo: (to: WasmAddress) => {
          const invoke = () => kernel_leaf(() => kernel_instance.exports.copy_siginfo(to));
          const result = fork ? fork.kernelCall(invoke) : invoke();
          const current = siginfo_copy_results.length - 1;
          if (current >= 0) siginfo_copy_results[current] = result;
          return result;
        },
      },
      linux_signal_v1: {
        finish(stack: WasmAddress, mask: WasmAddress) {
          const invoke = () =>
            kernel_leaf(() => kernel_instance.exports.finish_signal_frame?.(stack, mask) ?? -95);
          const result = fork ? fork.kernelCall(invoke) : invoke();
          const current = siginfo_copy_results.length - 1;
          if (current >= 0 && result < 0 && result !== -95) siginfo_copy_results[current] = result;
          return result;
        },
        frame(stack: WasmAddress, mask: WasmAddress) {
          const invoke = () =>
            kernel_leaf(() => kernel_instance.exports.copy_signal_frame?.(stack, mask) ?? -95);
          const result = fork ? fork.kernelCall(invoke) : invoke();
          const current = siginfo_copy_results.length - 1;
          if (current >= 0 && result < 0 && result !== -95) siginfo_copy_results[current] = result;
          return result;
        },
      },
      linux_signal_syscall_v1: {
        abi: () =>
          typeof kernel_instance.exports.copy_signal_syscall_v1 === "function" &&
          typeof kernel_instance.exports.finish_signal_syscall_v1 === "function"
            ? 1
            : 0,
        frame(address: WasmAddress) {
          const invoke = () =>
            kernel_leaf(() => kernel_instance.exports.copy_signal_syscall_v1?.(address) ?? -95);
          return fork ? fork.kernelCall(invoke) : invoke();
        },
        finish(address: WasmAddress) {
          const invoke = () =>
            kernel_leaf(() => kernel_instance.exports.finish_signal_syscall_v1?.(address) ?? -95);
          return fork ? fork.kernelCall(invoke) : invoke();
        },
      },
      linux_signal_cancel_v1: { abi: () => 1 },
    });
    if (context.dynamic?.worker_snapshot !== undefined) {
      // A shared callback Worker gets a new module instance, table, and loader
      // object. Reconstruct the published graph before the kernel makes its
      // callback runnable; the snapshot is clone-safe and contains no shared
      // data writes, constructors, or relocations to replay.
      const replay = prepare_dylink_worker_snapshot(context.dynamic.worker_snapshot);
      context.dynamic.worker_snapshot = replay;
      dynamic = create_dynamic_process(replay);
    }
    if (
      WebAssembly.Module.imports(context.module).some(
        (entry) => entry.module === "linux_user_poll_v1" || entry.module === "linux_user_poll_v2",
      )
    ) {
      const abi = created.exports.__wasm_user_poll_abi;
      assert(
        typeof abi === "function" && abi.length === 0 && abi() === (poll2 ? 2 : 1),
        "invalid compiler user poll execution ABI",
      );
    }
    if (poll_thread) poll_threads.set(created, poll_thread);
    maintenanceReady = true;
    return created;
  }

  function instantiate(fresh_memory: boolean): void {
    if (fresh_memory) {
      assert(pending);
      const retirementError = cleanup_active_worker_membership();
      if (retirementError) {
        terminate_for_membership_retirement(retirementError);
        throw HALT_KERNEL;
      }
      context = pending;
      pending = null;
      active_worker_membership = context.dynamic?.worker_membership ?? null;
      service_worker_membership = undefined;
      service_worker_checkpoint = undefined;
      call_entry = call_start;
      thread_entry = undefined;
    }

    assert(context);
    instance = create_instance(context);
    fork = uses_fork_continuation(context.module)
      ? new ForkContinuation(
          instance,
          context.memory,
          context.address,
          profile ? () => profile.childRewound() : undefined,
          get_kernel_instance().exports.fork_worker_abort_abi?.() === 1,
          get_kernel_instance().exports.native_clone3_fork_abi?.() === 1,
          () => {
            assert(instance && context && fork);
            const before = instance;
            const result = fork.kernelCall(() =>
              call_fork_child_return(
                get_kernel_instance().exports,
                before.exports,
                context!.memory,
                kernel_address,
              ),
            );
            if (instance !== before) {
              call_entry = call_start;
              throw HALT_USER;
            }
            assert(result === 0, `fork child return work failed (${result})`);
          },
        )
      : null;
  }

  const result: ReturnType<typeof user_imports> = {
    imports_brk_v1: {
      layout(destination) {
        if (!instance || !context) return -38;
        if (context.address !== kernel_address) return -95;
        return user_callback(() =>
          user_brk_layout(
            instance!.exports,
            context!.memory,
            context!.address,
            kernel_memory,
            destination,
          ),
        );
      },
      update(requested) {
        if (!instance || !context || context.address !== kernel_address)
          return kernel_address === "i64" ? -38n : -38;
        return user_callback(() => user_brk_update(instance!.exports, context!.address, requested));
      },
    },
    imports_fork_v1: {
      entry() {
        const entry =
          signal_depth === 0 && fork?.nativeClone3EntryAllowed()
            ? context?.fork_continuation?.entry
            : undefined;
        return entry === undefined
          ? kernel_address === "i64"
            ? 0n
            : 0
          : wasm_address_from_number(wasm_pointer_to_number(entry), kernel_address);
      },
    },
    get context() {
      return dynamic_vfork.context(context);
    },
    workerCheckpoint() {
      return service_worker_checkpoint?.() ?? 0;
    },
    prepare() {
      if (parent) instantiate(false);
    },
    applyForkAdvice() {
      if (!instance || !context) throw new Error("fork memory advice has no child instance");
      apply_fork_memory_advice(instance.exports, context.memory, context.address);
    },
    imports: {
      // program management:
      compile_begin(size) {
        pending_module_bytes = null;
        pending = null;
        try {
          pending_module_bytes = new Uint8Array(size >>> 0);
          return 0;
        } catch {
          return -12; // out of memory
        }
      },
      compile_write(buf, offset, size) {
        return write_exec_image(pending_module_bytes, kernel_memory, buf, offset, size);
      },
      compile_end(maximum_memory_pages) {
        const bytes = pending_module_bytes;
        pending_module_bytes = null;
        if (!bytes) return -22; // invalid argument

        const rlimit_pages = maximum_memory_pages >>> 0;
        let module: WebAssembly.Module;
        let minimum: number;
        let maximum: number;
        let dynamic: UserContext["dynamic"];
        try {
          const globals: WasmGlobalImport[] = [];
          const memories = read_wasm_memories(bytes, globals);
          const memory_import = user_memory_import(memories, kernel_address);
          if (!memory_import || !user_poll_globals_supported(globals, kernel_address)) return -8; // exec format error

          module = new WebAssembly.Module(bytes);
          const dynamic_profile = WebAssembly.Module.imports(module).some(
            (entry) => entry.module === "linux_dlopen_v1",
          );
          if (dynamic_profile) {
            if (uses_fork_continuation(module)) return -8;
            if (get_kernel_instance().exports.dynamic_file_pin_abi_v1?.() !== 1) return -8;
          }
          if (
            !user_module_imports_supported(module) ||
            !user_function_imports_supported(bytes, kernel_address, true) ||
            !fork_continuation_exports_supported(module)
          ) {
            return -8; // exec format error
          }
          if (
            uses_fork_continuation(module) &&
            !fork_child_return_supported(get_kernel_instance().exports)
          )
            return -8;
          if (
            WebAssembly.Module.imports(module).some(
              (entry) =>
                entry.module === "linux_user_poll_v1" || entry.module === "linux_user_poll_v2",
            )
          ) {
            const exports = get_kernel_instance().exports;
            if (
              typeof exports.user_poll_v1 !== "function" ||
              exports.user_poll_v1.length !== 0 ||
              typeof exports.user_context_v1 !== "function"
            )
              return -8;
          }

          minimum = Number(memory_import.type.minimum);
          maximum = Math.min(Number(memory_import.type.maximum), rlimit_pages);
          if (dynamic_profile) {
            const table = read_wasm_main_table(bytes);
            const signatures = read_wasm_dynamic_signatures(bytes, true);
            const metadata = prepare_dylink_call_metadata(bytes, true);
            module = new WebAssembly.Module(metadata.bytes);
            dynamic = {
              table,
              signatures: signatures.exports,
              tagSignatures: signatures.tagExports,
              functionMetadata: metadata.functions,
              privateExports: metadata.privateExports,
              process_state: create_dynamic_process_state(),
            };
          }
        } catch {
          return -8; // exec format error
        }

        if (maximum < minimum) return -12; // out of memory

        let allocated: ReturnType<typeof allocate_shared_memory>;
        try {
          allocated = allocate_shared_memory(minimum, maximum, undefined, kernel_address);
        } catch {
          return -12; // out of memory
        }

        const next_context = { module, ...allocated, ...(dynamic ? { dynamic } : {}) };
        pending = next_context;
        return 0;
      },
      compile_abort() {
        pending_module_bytes = null;
        pending = null;
      },
      instantiate(fresh_memory) {
        user_callback(() => instantiate(Boolean(fresh_memory)));
      },
      call() {
        for (;;) {
          try {
            register_remote_memory();
            call_entry();
            if (fork?.unwinding()) {
              assert(context);
              const continuation = fork;
              resume_fork_parent(
                context,
                continuation,
                fork_signal_test
                  ? () =>
                      continuation.kernelCall(() =>
                        inject_saved_fork_signal(
                          get_kernel_instance().exports.syscall,
                          kernel_address,
                        ),
                      )
                  : undefined,
                fork_resume_signal_test
                  ? () =>
                      continuation.kernelCall(() =>
                        inject_resume_fork_signal(
                          get_kernel_instance().exports.syscall,
                          kernel_address,
                        ),
                      )
                  : undefined,
              );
            }
          } catch (error) {
            if (error === HALT_USER) continue;
            if (error === HALT_KERNEL) throw error;
            console.error("error running user module:", error);
            return;
          }
        }
      },
      switch_entry(fn, arg) {
        return user_callback(() => {
          // This is called if this thread was created by a clone call,
          // so its entrypoint is a user-specified function.
          // The worker prepares an instance sharing the parent's user context
          // before the kernel enters this callback.

          assert(parent);

          if (context?.fork_continuation) {
            const snapshot = context.fork_continuation;
            assert(
              fork && snapshot.entry === fn && (arg === 0 || arg === 0n),
              "invalid fork child entry",
            );
            if (fork_child_signal_test) {
              const continuation = fork;
              // switch_entry is still a kernel startup callback. Defer all test
              // syscalls until the regular user.call boundary, before rewinding.
              call_entry = () => {
                assert(context && context.fork_continuation === snapshot);
                resume_fork_child(context, continuation, () =>
                  continuation.kernelCall(() =>
                    inject_child_fork_signal(get_kernel_instance().exports.syscall, kernel_address),
                  ),
                );
                call_entry = call_start;
                call_start();
              };
              return;
            }
            if (profile) profile.prepareChild(() => fork!.resumeChild(snapshot));
            else fork.resumeChild(snapshot);
            delete context.fork_continuation;
            call_entry = call_start;
            return;
          }

          const callback_entry = () => {
            assert(instance);

            const { __indirect_function_table } = instance.exports;
            assert(
              __indirect_function_table instanceof WebAssembly.Table,
              "Invalid function table",
            );

            const f = wasm_table_get(__indirect_function_table, fn);
            assert(typeof f === "function" && f.length === 1, "Invalid function signature");

            f(arg);

            // throw new Error("thread entrypoint reached the end without exiting");
            console.warn("thread entrypoint reached the end without exiting");
          };
          thread_entry = callback_entry;
          call_entry = callback_entry;
        });
      },

      // signal handling:
      call_signal_handler(fn, sig) {
        assert(instance);
        register_remote_memory();

        const { __indirect_function_table } = instance.exports;
        assert(__indirect_function_table instanceof WebAssembly.Table, "Invalid function table");

        const f = wasm_table_get(__indirect_function_table, fn);
        assert(typeof f === "function" && f.length === 1, "Invalid function signature");

        signal_depth++;
        try {
          call_signal_callback(
            () => call_plain_signal_handler(instance!.exports, fn, sig, () => f(sig)),
            () => kernel_leaf(() => get_kernel_instance().exports.clear_siginfo()),
            HALT_KERNEL,
          );
        } finally {
          signal_depth--;
        }
      },
      call_siginfo_handler(trampoline, fn, sig) {
        assert(instance);
        register_remote_memory();

        const { __indirect_function_table } = instance.exports;
        assert(__indirect_function_table instanceof WebAssembly.Table, "Invalid function table");

        const f = wasm_table_get(__indirect_function_table, trampoline);
        assert(typeof f === "function" && f.length === 2, "Invalid siginfo trampoline");

        siginfo_copy_results.push(null);
        signal_depth++;
        try {
          return call_signal_callback(
            () => {
              f(fn, sig);
              return siginfo_copy_results.at(-1) ?? -22;
            },
            () => kernel_leaf(() => get_kernel_instance().exports.clear_siginfo()),
            HALT_KERNEL,
          );
        } finally {
          signal_depth--;
          siginfo_copy_results.pop();
        }
      },

      // memory:
      read(to, from, n) {
        const length = wasm_size_to_number(n);
        if (!context) return length;
        return read_user_memory(kernel_memory, to, context.memory, from, length);
      },
      write(to, from, n) {
        const length = wasm_size_to_number(n);
        if (!context) return length;
        return write_user_memory(context.memory, to, kernel_memory, from, length);
      },
      write_zeroes(to, n) {
        const length = wasm_size_to_number(n);
        if (!context) return length;
        return clear_user_memory(context.memory, to, length);
      },
      futex_atomic_op(oldval, uaddr, op, oparg) {
        const word = context && user_atomic_word(context.memory, uaddr);
        if (!word) return -14; // bad address

        let old: number;
        switch (op) {
          case 0: // FUTEX_OP_SET
            old = Atomics.exchange(word, 0, oparg);
            break;
          case 1: // FUTEX_OP_ADD
            old = Atomics.add(word, 0, oparg);
            break;
          case 2: // FUTEX_OP_OR
            old = Atomics.or(word, 0, oparg);
            break;
          case 3: // FUTEX_OP_ANDN
            old = Atomics.and(word, 0, ~oparg);
            break;
          case 4: // FUTEX_OP_XOR
            old = Atomics.xor(word, 0, oparg);
            break;
          default:
            return -38; // function not implemented
        }

        return write_kernel_u32(oldval, old) ? 0 : -14; // bad address
      },
      futex_atomic_cmpxchg(oldval, uaddr, expected, replacement) {
        const word = context && user_atomic_word(context.memory, uaddr);
        if (!word) return -14; // bad address

        const old = Atomics.compareExchange(word, 0, expected, replacement);
        return write_kernel_u32(oldval, old) ? 0 : -14; // bad address
      },
      mmap(len) {
        assert(instance);
        const callback = instance.exports.__wasm_mmap;
        if (typeof callback !== "function") return kernel_address === "i64" ? -38n : -38;
        return user_callback(() => callback(len) as WasmAddress);
      },
      munmap(addr, len) {
        assert(instance);
        const callback = instance.exports.__wasm_munmap;
        if (typeof callback !== "function") return kernel_address === "i64" ? -38n : -38;
        return user_callback(() => callback(addr, len) as WasmAddress);
      },
    },
    imports_signal_v1: {
      stack_pointer(to) {
        if (!instance || !context) return -95;
        const raw = read_signal_stack_pointer(instance.exports, context.memory, context.address);
        if (raw === null) return -95;
        try {
          const value = wasm_pointer_to_number(raw);
          if (kernel_address === "i32" && value > 0xffffffff) return -75;
          const bytes = memory_bytes(
            kernel_memory,
            wasm_pointer_to_number(to),
            kernel_address === "i64" ? 8 : 4,
          );
          if (!bytes) return -14;
          const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
          if (kernel_address === "i64") view.setBigUint64(0, BigInt(value), true);
          else view.setUint32(0, value, true);
          return 0;
        } catch {
          return -14;
        }
      },
      call_handler(trampoline, fn, sig, sp, base, size, flags) {
        if (!instance || !context) return -95;
        return call_on_signal_stack(
          instance.exports,
          context.memory,
          context.address,
          sp,
          base,
          size,
          flags,
          () => {
            if (flags & 1) return result.imports.call_siginfo_handler(trampoline, fn, sig);
            result.imports.call_signal_handler(fn, sig);
            return 0;
          },
        );
      },
    },
    imports_v2: {
      mremap_fixed(addr, oldLen, newLen, newAddr) {
        assert(instance);
        return user_callback(() =>
          user_mremap_fixed(instance!.exports, kernel_address, addr, oldLen, newLen, newAddr),
        );
      },
      mmap_fixed(addr, len) {
        assert(instance);
        return user_callback(() => user_mmap_fixed(instance!.exports, kernel_address, addr, len));
      },
      madvise(addr, len, advice) {
        assert(instance);
        return user_callback(() =>
          user_madvise(instance!.exports, kernel_address, addr, len, advice),
        );
      },
      msync(addr, len, flags) {
        assert(instance);
        return user_callback(() => user_msync(instance!.exports, kernel_address, addr, len, flags));
      },
      mremap(addr, oldLen, newLen, flags) {
        assert(instance);
        return user_callback(() =>
          user_mremap(instance!.exports, kernel_address, addr, oldLen, newLen, flags),
        );
      },
      mremap_dontunmap(addr, oldLen, newLen, flags, newAddr) {
        assert(instance);
        return user_callback(() =>
          user_mremap_dontunmap(
            instance!.exports,
            kernel_address,
            addr,
            oldLen,
            newLen,
            flags,
            newAddr,
          ),
        );
      },
      mmap(addr, len, prot, flags, fd, pgoff) {
        assert(instance);
        return user_callback(() =>
          user_mmap(instance!.exports, kernel_address, addr, len, prot, flags, fd, pgoff),
        );
      },
    },
    imports_mmap_query_v1: {
      span(address, pages) {
        assert(instance);
        return user_callback(() =>
          user_mmap_query(instance!.exports, kernel_address, address, pages),
        );
      },
    },
    imports_mmap_stream_v1: {
      capabilities() {
        assert(instance);
        return mmap_copy.stream_capabilities(instance.exports);
      },
      map(rounded) {
        assert(instance);
        return user_callback(() =>
          mmap_copy.map_stream(
            instance!.exports,
            rounded,
            (destination, length) => {
              try {
                return kernel_leaf(() =>
                  get_kernel_instance().exports.populate_file_mmap_v1!(destination, length),
                );
              } catch (error) {
                // This private export executes only kernel/VFS code. A trap
                // may strand a producer; do not resume user code or free its
                // storage through the ordinary callback-abort path.
                if (error !== HALT_KERNEL) console.error("kernel file-map producer failed:", error);
                postMessage({ type: "terminate_machine", reason: MachineTerminationReason.Panic });
                throw HALT_KERNEL;
              }
            },
            (error) => {
              if (error !== HALT_KERNEL)
                kernel_leaf(() => get_kernel_instance().exports.abort_file_mmap_v1?.());
            },
          ),
        );
      },
    },
    imports_mmap_init_v1: {
      capabilities() {
        assert(instance);
        return mmap_copy.capabilities(instance.exports);
      },
      map(rounded, source, length) {
        assert(instance);
        // Refuse pre-cleanup kernels before transitioning into user callback
        // context. Their original normal return path can release staging.
        if (!mmap_copy.kernel_supported()) return kernel_address === "i64" ? -95n : -95;
        return user_callback(() =>
          mmap_copy.map(instance!.exports, rounded, source, length, (error) => {
            // exit_thread already released callback resources before handing
            // its CPU away. Never re-enter a dead task's kernel instance.
            if (error !== HALT_KERNEL)
              kernel_leaf(() => get_kernel_instance().exports.abort_file_mmap_v1?.());
          }),
        );
      },
    },
  };
  return result;
}

function start({
  fn,
  arg,
  vmlinux,
  memory,
  kernel_address,
  user: initial_user_context,
  user_copy_status,
  shared_user_prepare = false,
  copy_fault,
  fork_profile,
}: InitMessage) {
  const profile = create_fork_profile(fork_profile, profile_output);
  if (profile) postMessage({ type: "fork_profile_started" });
  let user_context = shared_user_prepare
    ? initial_user_context
    : without_worker_membership(initial_user_context);
  active_worker_membership = shared_user_prepare
    ? (user_context?.dynamic?.worker_membership ?? null)
    : null;
  const cancelled = () => {
    if (!user_copy_failed(user_copy_status)) return false;
    stop_worker();
    return true;
  };
  if (cancelled()) return;
  if (
    shared_user_prepare &&
    (!user_copy_status ||
      !user_context?.dynamic?.worker_snapshot ||
      !user_context.dynamic.worker_membership)
  )
    throw new Error(
      "shared dynamic Worker preparation has no replay snapshot, membership, or acknowledgement",
    );
  if (user_copy_status && !shared_user_prepare) inject_copy_fault(copy_fault, "initialize");
  // Refresh every WebAssembly.Memory received across a worker boundary
  // immediately, including any future additions to InitMessage. Chromium can
  // retain the fixed-length buffer wrapper captured before another isolate
  // grows it; grow(0) refreshes the wrapper before constructing any views.
  refresh_memory(memory, kernel_address);
  if (initial_user_context) {
    refresh_memory(initial_user_context.memory, initial_user_context.address);
  }

  if (user_copy_status && !shared_user_prepare) {
    assert(user_context);
    // fork.c permits COPY only for a single-user mm. The caller blocks until
    // publication or timeout; a timed-out copy must never be published. Allocate here so the
    // private backing store is owned by the destination isolate, not the
    // long-lived parent.
    try {
      inject_copy_fault(copy_fault, "allocate");
      const source = memory_bytes(user_context.memory, 0);
      if (!source) throw new RangeError("invalid source memory");
      const { maximum_pages, address } = user_context;
      const allocate = () =>
        allocate_shared_memory(source.byteLength / 0x10000, maximum_pages, undefined, address);
      const copied = profile ? profile.measure("allocate_ns", allocate) : allocate();
      const destination = memory_bytes(copied.memory, 0, source.byteLength);
      if (!destination) throw new RangeError("invalid destination memory");
      if (profile) profile.measure("copy_ns", () => destination.set(source));
      else destination.set(source);
      user_context = { ...user_context, ...copied };
    } catch {
      settle_user_copy(user_copy_status, USER_COPY_NO_MEMORY);
      stop_worker();
      return;
    }
  }

  if (cancelled()) return;
  const user = user_imports({
    kernel_memory: memory,
    kernel_address,
    get_kernel_instance: () => instance,
    parent_user: user_context,
    profile,
  });

  const imports = {
    env: { memory },
    remote_memory_v1: {
      copy(id, user, kernel, length, write): number {
        return request_remote_memory(
          postMessage,
          { kind: write ? "write" : "read", id, user, kernel, length },
          { yieldKernel: instance.exports.copy_worker_wait },
        );
      },
      release(id) {
        // No kernel buffer is retained. Shutdown must not block the main
        // agent or wait for a reply while tearing down this mm.
        try {
          postMessage({
            type: "remote_memory",
            operation: { kind: "release", id },
            reply: new SharedArrayBuffer(8),
          });
        } catch {
          /* Machine teardown also drops all retained references. */
        }
      },
    },
    boot: {
      get_devicetree: unavailable,
      get_initramfs: unavailable,
    },
    user: user.imports,
    user_context_v1: user_context_imports(),
    user_fork_v1: user.imports_fork_v1,
    user_brk_v1: user.imports_brk_v1,
    user_mmap_query_v1: user.imports_mmap_query_v1,
    user_v2: user.imports_v2,
    user_signal_v1: user.imports_signal_v1,
    user_mmap_init_v1: user.imports_mmap_init_v1,
    user_mmap_stream_v1: user.imports_mmap_stream_v1,
    kernel: kernel_imports({
      address: kernel_address,
      is_worker: true,
      memory,
      worker_checkpoint: user.workerCheckpoint,
      spawn_worker(fn, arg, name, user, copy_user_memory, shared_user_prepare): number {
        let channel: MessageChannel | undefined;
        let user_copy_status: UserCopyStatus | null;
        try {
          channel = new MessageChannel();
          user_copy_status =
            copy_user_memory || shared_user_prepare
              ? new Int32Array(new SharedArrayBuffer(4 * copy_status_words()))
              : null;
        } catch (error) {
          console.error("could not allocate callback Worker handoff:", error);
          channel?.port1.close();
          channel?.port2.close();
          return -12;
        }
        if (!channel) return -12;
        const direct = channel;
        let admissionChannel: DylinkWorkerChannel | null = null;
        let admissionToken: DylinkWorkerAdmissionToken | null = null;
        let admissionPending = false;
        let childUser = shared_user_prepare ? user : without_worker_membership(user);
        const cancelAdmission = (error: number) => {
          // Publish failure before withdrawing the token so a late child cannot
          // enter its guest callback after timeout or handoff failure.
          if (user_copy_status) settle_user_copy(user_copy_status, error);
          if (!admissionPending || !admissionChannel || !admissionToken) return;
          const cancelled = retry_busy_channel_operation(
            () => admissionChannel!.cancelAdmission(admissionToken!),
            user_copy_status!,
          );
          if (!cancelled.ok && cancelled.errno !== ESTALE) {
            console.error("could not cancel dynamic Worker admission:", cancelled.errno);
          }
          admissionPending = false;
        };

        if (shared_user_prepare) {
          const dynamic = user?.dynamic;
          const membership = dynamic?.worker_membership;
          if (!user || !dynamic || !membership || !user_copy_status) {
            cancelAdmission(-95);
            direct.port1.close();
            direct.port2.close();
            return -95;
          }
          try {
            admissionChannel = DylinkWorkerChannel.attach(membership.shared);
            const admission = admissionChannel.beginAdmission();
            if (!admission.ok) {
              settle_user_copy(user_copy_status, admission.errno);
              direct.port1.close();
              direct.port2.close();
              return admission.errno;
            }
            admissionToken = admission.value;
            admissionPending = true;
            childUser = {
              ...user,
              dynamic: {
                ...dynamic,
                worker_membership: {
                  shared: membership.shared,
                  participant: admissionToken,
                },
              },
            };
          } catch (error) {
            const errno = error instanceof DylinkWorkerChannelError ? -Math.abs(error.errno) : -5;
            settle_user_copy(user_copy_status, errno);
            direct.port1.close();
            direct.port2.close();
            return errno;
          }
        }

        const fork_profile = copy_user_memory ? new_fork_profile_request() : undefined;
        const parent_profile = create_fork_profile(fork_profile, profile_output);
        try {
          postMessage(
            {
              type: "spawn_worker",
              name,
              port: direct.port1,
              user_copy_status,
              shared_user_prepare,
              ...(fork_profile ? { fork_profile } : {}),
            },
            [direct.port1],
          );
        } catch (error) {
          console.error("could not publish callback Worker:", error);
          cancelAdmission(-11);
          direct.port1.close();
          direct.port2.close();
          return -11;
        }
        try {
          direct.port2.postMessage({
            type: "init",
            fn,
            arg,
            vmlinux,
            memory,
            kernel_address,
            user: childUser,
            user_copy_status,
            shared_user_prepare,
            ...(fork_profile ? { fork_profile } : {}),
          } satisfies InitMessage);
        } catch (error) {
          console.error("could not send callback Worker initialization:", error);
          cancelAdmission(-11);
          try {
            direct.port2.postMessage({ type: "abort_init" } satisfies AbortWorkerInitMessage);
          } catch {
            direct.port2.close();
          }
          return -11;
        }
        if (!user_copy_status) {
          if (admissionPending) {
            // A shared replay always needs an acknowledgement. Keep a malformed
            // caller from leaving a pending slot that blocks every writer.
            cancelAdmission(-5);
            return -5;
          }
          return 0;
        }
        const schedule = instance.exports.copy_worker_wait;
        let scheduling_points = 0;
        const cooperate =
          schedule && copy_fault_test
            ? () => {
                schedule();
                scheduling_points++;
              }
            : schedule && parent_profile
              ? () =>
                  parent_profile.cooperate(
                    schedule,
                    () => Atomics.load(user_copy_status, 0) === USER_COPY_COMPLETE,
                  )
              : schedule;
        let result: number;
        try {
          result = parent_profile
            ? parent_profile.wait(() => wait_user_copy(user_copy_status, 30_000, cooperate))
            : wait_user_copy(user_copy_status, 30_000, cooperate);
          require_copy_wait_progress(user_copy_status, scheduling_points);
          join_copy_timeout(user_copy_status);
        } catch (error) {
          cancelAdmission(-11);
          throw error;
        }

        if (admissionPending && admissionChannel && admissionToken) {
          if (result === USER_COPY_COMPLETE) {
            const completed = retry_busy_channel_operation(
              () => admissionChannel!.completeAdmission(admissionToken!),
              user_copy_status,
            );
            admissionPending = false;
            if (!completed.ok && completed.errno !== ESTALE) {
              // Replay already succeeded and the child may be running. Losing
              // its cohort membership now is an internal consistency failure.
              console.error("could not complete dynamic Worker admission:", completed.errno);
              postMessage({ type: "terminate_machine", reason: MachineTerminationReason.Panic });
            }
          } else {
            cancelAdmission(result < 0 ? result : -11);
          }
        }
        if (result === USER_COPY_COMPLETE) parent_profile?.parentReady();
        return result === USER_COPY_COMPLETE ? 0 : result;
      },
      boot_console_write(message) {
        postMessage({ type: "boot_console_write", message });
      },
      boot_console_close() {
        postMessage({ type: "boot_console_close" });
      },
      terminate_machine(reason) {
        postMessage({ type: "terminate_machine", reason });
      },
      run_on_main(fn, arg) {
        postMessage({ type: "run_on_main", fn, arg });
      },
      get_user_context() {
        return user.context;
      },
      worker_exit() {
        terminate_for_membership_retirement(cleanup_active_worker_membership());
        service_worker_membership = undefined;
        service_worker_checkpoint = undefined;
        postMessage({ type: "worker_exit" });
      },
    }),
    virtio: {
      set_features: unavailable,
      setup: unavailable,
      reset: unavailable,
      enable_vring: unavailable,
      disable_vring: unavailable,
      notify: unavailable,
    },
  } satisfies Imports;

  const instantiate_kernel = () => new WebAssembly.Instance(vmlinux, imports) as Instance;
  const instance = profile
    ? profile.measure("kernel_instance_ns", instantiate_kernel)
    : instantiate_kernel();
  try {
    if (profile) profile.measure("user_instance_ns", () => user.prepare());
    else user.prepare();
  } catch (error) {
    if (!shared_user_prepare || !user_copy_status) throw error;
    let errno = 5; // EIO for an unexpected replay implementation failure.
    if (error instanceof DylinkWorkerSnapshotError) {
      errno = error.code === "ENOMEM" ? 12 : error.code === "EINVAL" ? 22 : 95;
    } else {
      console.error("dynamic Worker graph replay failed:", error);
    }
    settle_user_copy(user_copy_status, -errno);
    stop_worker();
    return;
  }
  if (user_copy_status && !shared_user_prepare) {
    try {
      user.applyForkAdvice();
    } catch {
      settle_user_copy(user_copy_status, USER_COPY_NO_MEMORY);
      stop_worker();
      return;
    }
    pause_copy_publication(copy_fault, user_copy_status);
  }
  if (user_copy_status && !settle_user_copy(user_copy_status, USER_COPY_COMPLETE)) {
    acknowledge_copy_timeout(copy_fault, user_copy_status);
    stop_worker();
    return;
  }
  profile?.childReady();
  try {
    wasm_table_get(instance.exports.__indirect_function_table, fn)!(arg);
  } catch (error) {
    if (error === HALT_KERNEL) return;
    throw error;
  }
}

function start_with_shared_ack(init: InitMessage): void {
  try {
    start(init);
  } catch (error) {
    if (!init.shared_user_prepare || !init.user_copy_status) throw error;
    const status = Atomics.load(init.user_copy_status, 0);
    if (status === USER_COPY_COMPLETE) {
      // The replay acknowledgement was already published; this is now an
      // unexpected failure in the admitted child, so retire its live token and
      // preserve the original failure for the Worker host.
      terminate_for_membership_retirement(cleanup_active_worker_membership());
      service_worker_membership = undefined;
      throw error;
    }
    console.error("shared dynamic Worker preparation failed:", error);
    if (status === 0) settle_user_copy(init.user_copy_status, -5); // EIO: never publish an unprepared child.
    stop_worker();
  }
}

listen_endpoint(endpoint, {
  message(raw) {
    const message = raw as InitMessage | ForwardedInitMessage;

    // Initial workers receive InitMessage directly from the page. Workers
    // spawned by another worker receive their InitMessage over this port, which
    // works around a WebKit bug reclaiming shared Wasm memory across JS VMs.
    if (message.type === "forwarded_init") {
      message.port.onmessage = ({ data }) => {
        message.port.close();
        if (
          data !== null &&
          typeof data === "object" &&
          (data as AbortWorkerInitMessage).type === "abort_init"
        ) {
          if (message.user_copy_status) settle_user_copy(message.user_copy_status, -11);
          stop_worker();
          return;
        }
        const init = data as InitMessage;
        start_with_shared_ack({
          ...init,
          shared_user_prepare: message.shared_user_prepare ?? init.shared_user_prepare,
          copy_fault: message.copy_fault,
        });
      };
      message.port.start();
      return;
    }

    start_with_shared_ack(message);
  },
});
