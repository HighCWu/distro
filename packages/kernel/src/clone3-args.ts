// SPDX-License-Identifier: MIT
// Linux clone_args uses aligned u64 fields; legacy clone uses machine words.
// Only the existing single-thread, default-stack fork shape is admitted here.
import { memory_bytes, type WasmAddress, type WasmAddressType } from "./wasm.ts";

export interface CloneForkRequest {
  pidfd: WasmAddress | null;
  namespaceFlags?: WasmAddress;
  tids?: { flags: WasmAddress; parent: WasmAddress; child: WasmAddress };
}

const namespaceMask = 0x7e020000n;
const tidMask = 0x01300000n;

function unsigned_word(value: WasmAddress, address: WasmAddressType): bigint {
  if (
    typeof value !== (address === "i64" ? "bigint" : "number") ||
    (typeof value === "number" && !Number.isSafeInteger(value))
  )
    throw new Error("invalid word");
  return BigInt.asUintN(address === "i64" ? 64 : 32, BigInt(value));
}

function fork_options(
  memory: WebAssembly.Memory,
  address: WasmAddressType,
  flags: bigint,
  pidfd: bigint,
  parentTid = 0n,
  childTid = 0n,
): number | CloneForkRequest {
  const namespaces = flags & namespaceMask;
  const options: Omit<CloneForkRequest, "pidfd"> = namespaces
    ? { namespaceFlags: address === "i64" ? namespaces : Number(namespaces) }
    : {};
  if (flags & tidMask) {
    // Linux performs TID stores (including its own fault behavior). Refuse
    // only addresses that the Wasm architecture cannot represent faithfully.
    if (address === "i32" && (parentTid > 0xffffffffn || childTid > 0xffffffffn)) return -14;
    const p = (n: bigint) => (address === "i64" ? n : Number(n));
    options.tids = { flags: p(flags & tidMask), parent: p(parentTid), child: p(childTid) };
  }
  if (!(flags & 0x1000n)) return { pidfd: null, ...options };
  if (
    pidfd === 0n ||
    pidfd > BigInt(Number.MAX_SAFE_INTEGER) ||
    (address === "i32" && pidfd > 0xffffffffn) ||
    !memory_bytes(memory, Number(pidfd), 4)
  )
    return -14;
  return { pidfd: address === "i64" ? pidfd : Number(pidfd), ...options };
}

/** Linux default clone(flags, stack, ptid/pidfd, ctid, tls); no callback layout. */
export function clone_fork_request(
  memory: WebAssembly.Memory,
  address: WasmAddressType,
  args: WasmAddress[],
): number | CloneForkRequest {
  const zero = (v: WasmAddress | undefined) => v === 0 || v === 0n;
  if (args.length !== 6 || !zero(args[1])) return -95;
  let flags: bigint;
  try {
    // Legacy Linux clone consumes lower_32_bits(flags), unlike clone3's u64
    // flag field. Only flags are narrowed; a PIDFD pointer must keep its width.
    flags = BigInt.asUintN(32, unsigned_word(args[0]!, address));
  } catch {
    return -95;
  }
  if ((flags & 0xffn) !== 17n || flags & ~(namespaceMask | tidMask | 0x1000n | 0xffn)) return -95;
  if (!(flags & (0x1000n | tidMask))) {
    // No supported flag requests parent/child TID or TLS updates. Linux
    // ignores those registers (often unspecified in short syscall calls).
    return fork_options(memory, address, flags, 0n);
  }
  let pidfd: bigint;
  try {
    pidfd = flags & 0x1000n ? unsigned_word(args[2]!, address) : 0n;
    const parent = flags & 0x100000n ? unsigned_word(args[2]!, address) : 0n;
    const child = flags & 0x1200000n ? unsigned_word(args[3]!, address) : 0n;
    return fork_options(memory, address, flags, pidfd, parent, child);
  } catch {
    return -14;
  }
}

export function clone3_fork_request(
  memory: WebAssembly.Memory,
  address: WasmAddressType,
  pointer: WasmAddress,
  size: WasmAddress,
): number | CloneForkRequest {
  const unsigned = (value: WasmAddress) => unsigned_word(value, address);
  let length: bigint;
  try {
    length = unsigned(size);
  } catch {
    return -22;
  }
  // Match this architecture's 64 KiB PAGE_SIZE and Linux's VER0 minimum.
  if (length > 65536n) return -7;
  if (length < 64n) return -22;
  let offset: bigint;
  try {
    offset = unsigned(pointer);
  } catch {
    return -14;
  }
  if (offset === 0n || offset > BigInt(Number.MAX_SAFE_INTEGER)) return -14;
  const source = memory_bytes(memory, Number(offset), Number(length));
  if (!source) return -14;
  // Copy once before parsing; never repeatedly read fields from shared memory.
  const bytes = new Uint8Array(source);
  if (bytes.subarray(88).some((byte) => byte !== 0)) return -7;
  const known = new Uint8Array(88);
  known.set(bytes.subarray(0, 88));
  const view = new DataView(known.buffer);
  const field = (index: number) => view.getBigUint64(index * 8, true);
  const flags = field(0),
    signal = field(4),
    stack = field(5),
    stackSize = field(6);
  const tids = field(8),
    tidCount = field(9);
  // clone3 does not encode CSIGNAL in flags. CLONE_NEWTIME's reused bit is
  // excluded from this syntactic check but still unsupported below.
  if ((flags & 0x7fn) !== 0n || (flags & 0x400000n) !== 0n || signal > 64n) return -22;
  if ((stack === 0n) !== (stackSize === 0n)) return -22;
  if (tidCount > 32n || (tids === 0n) !== (tidCount === 0n)) return -22;
  if (signal !== 17n) return -95;
  // Linux owns namespace configuration, capabilities and flag combinations.
  // These bits fit legacy clone's flags word. NEWTIME (0x80) does not: that
  // word encodes CSIGNAL there, so it must never be silently dropped.
  if (flags & ~(namespaceMask | tidMask | 0x1000n)) return -95;
  for (let index = 1; index < 11; index++)
    if (
      index !== 4 &&
      !(index === 1 && flags & 0x1000n) &&
      !(index === 2 && flags & 0x1200000n) &&
      !(index === 3 && flags & 0x100000n) &&
      field(index) !== 0n
    )
      return -95;
  // Do not truncate a clone_args u64 pointer to the module's pointer width.
  // Linux owns the actual write and fd allocation/rollback, not this parser.
  return fork_options(
    memory,
    address,
    flags,
    field(1),
    flags & 0x100000n ? field(3) : 0n,
    flags & 0x1200000n ? field(2) : 0n,
  );
}
