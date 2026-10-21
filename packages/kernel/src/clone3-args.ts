// SPDX-License-Identifier: MIT
// Linux clone_args is an array of aligned u64 fields on BOTH pointer widths.
// Only the existing single-thread, default-stack fork shape is admitted here.
import { memory_bytes, type WasmAddress, type WasmAddressType } from "./wasm.ts";

export function clone3_fork_request(
  memory: WebAssembly.Memory,
  address: WasmAddressType,
  pointer: WasmAddress,
  size: WasmAddress,
): number | { pidfd: WasmAddress | null } {
  const unsigned = (value: WasmAddress) => {
    if (
      typeof value !== (address === "i64" ? "bigint" : "number") ||
      (typeof value === "number" && !Number.isSafeInteger(value))
    )
      throw new Error("invalid word");
    return BigInt.asUintN(address === "i64" ? 64 : 32, BigInt(value));
  };
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
  if (flags !== 0n && flags !== 0x1000n) return -95; // CLONE_PIDFD only
  for (let index = 1; index < 11; index++)
    if (index !== 4 && !(index === 1 && flags === 0x1000n) && field(index) !== 0n) return -95;
  if (!flags) return { pidfd: null };
  const pidfd = field(1);
  // Do not truncate a clone_args u64 pointer to the module's pointer width.
  // Linux owns the actual write and fd allocation/rollback, not this parser.
  if (
    pidfd === 0n ||
    pidfd > BigInt(Number.MAX_SAFE_INTEGER) ||
    (address === "i32" && pidfd > 0xffffffffn) ||
    !memory_bytes(memory, Number(pidfd), 4)
  )
    return -14;
  return { pidfd: address === "i64" ? pidfd : Number(pidfd) };
}
