// SPDX-License-Identifier: MIT
// Linux clone_args uses aligned u64 fields; legacy clone uses machine words.
// Only the existing single-thread, default-stack fork shape is admitted here.
import { memory_bytes, type WasmAddress, type WasmAddressType } from "./wasm.ts";

export interface CloneForkRequest {
  pidfd: WasmAddress | null;
  namespaceFlags?: WasmAddress;
  sharingFlags?: WasmAddress;
  tids?: { flags: WasmAddress; parent: WasmAddress; child: WasmAddress };
  flags64?: bigint;
  cgroup?: bigint;
  setTid?: number[];
  exitSignal?: number;
  parentFlags?: WasmAddress;
}

const namespaceMask = 0x7e020000n;
const sharingMask = 0x40600n; // CLONE_FS | CLONE_FILES | CLONE_SYSVSEM, independent mm.
const parentMask = 0x8000n;
const tidMask = 0x01300000n;
const clearSighand = 0x100000000n;
const newTime = 0x80n;
const intoCgroup = 0x200000000n;
const noNewPrivs = 0x800000000n;
const autoReap = 0x400000000n;
const autoKill = 0x1000000000n;

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
  if (flags & sharingMask)
    options.sharingFlags = address === "i64" ? flags & sharingMask : Number(flags & sharingMask);
  if (flags & parentMask) options.parentFlags = address === "i64" ? parentMask : Number(parentMask);
  if (flags & (clearSighand | newTime | intoCgroup | noNewPrivs | autoReap | autoKill))
    options.flags64 =
      flags & (clearSighand | newTime | intoCgroup | noNewPrivs | autoReap | autoKill);
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
  if (
    (flags & 0xffn) !== 17n ||
    flags & ~(namespaceMask | sharingMask | parentMask | tidMask | 0x1000n | 0xffn)
  )
    return -95;
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
  // excluded from this syntactic check and requires native clone3 transport.
  if ((flags & 0x7fn) !== 0n || (flags & 0x400000n) !== 0n || signal > 64n) return -22;
  if (flags & clearSighand && flags & 0x800n) return -22;
  if ((stack === 0n) !== (stackSize === 0n)) return -22;
  if (tidCount > 32n || (tids === 0n) !== (tidCount === 0n)) return -22;
  if (flags & intoCgroup && (length < 88n || field(10) > 0x7fffffffn)) return -22;
  // Linux owns namespace configuration, capabilities and flag combinations.
  // Namespace/TID bits fit the old transport. CLEAR_SIGHAND and NEWTIME
  // require native transport: NEWTIME aliases a legacy CSIGNAL bit.
  if (
    flags &
    ~(
      namespaceMask |
      sharingMask |
      parentMask |
      tidMask |
      clearSighand |
      newTime |
      intoCgroup |
      noNewPrivs |
      autoReap |
      autoKill |
      0x1000n
    )
  )
    return -95;
  if (stack !== 0n || stackSize !== 0n) return -95;
  // Linux consults PIDFD/TID/TLS fields only when their flags request them.
  // In particular an unused u64 may not fit a wasm32 pointer, and must not be
  // validated, truncated into a different target, or written by the adapter.
  // Do not truncate a clone_args u64 pointer to the module's pointer width.
  // Linux owns the actual write and fd allocation/rollback, not this parser.
  const request = fork_options(
    memory,
    address,
    flags,
    field(1),
    flags & 0x100000n ? field(3) : 0n,
    flags & 0x1200000n ? field(2) : 0n,
  );
  if (typeof request !== "number" && signal !== 17n) request.exitSignal = Number(signal);
  if (typeof request !== "number" && flags & intoCgroup) request.cgroup = field(10);
  if (typeof request !== "number" && tidCount) {
    if (tids > BigInt(Number.MAX_SAFE_INTEGER) || (address === "i32" && tids > 0xffffffffn))
      return -14;
    const source = memory_bytes(memory, Number(tids), Number(tidCount) * 4);
    if (!source) return -14;
    // pid_t is signed 32-bit on both architectures. Preserve values for Linux
    // permission/range/collision checks, but capture before Asyncify changes frames.
    const copy = new Uint8Array(source);
    const view = new DataView(copy.buffer);
    request.setTid = Array.from({ length: Number(tidCount) }, (_, i) => view.getInt32(i * 4, true));
  }
  return request;
}
