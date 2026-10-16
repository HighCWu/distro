// SPDX-License-Identifier: MIT
// Native LP64 kernel ABI facts selected by explicit wasm64 sessions.
// The default session remains wasm32. Validate these facts against target headers before
// using them: libc's public struct stat is not the raw kernel syscall layout.
import { I32LE, I64LE, U32LE, U64LE } from "@lowland/bytes";
import { abi_checks as wasm32_checks, define_struct, NR as wasm32_nr } from "./abi.ts";

const {
  llseek: _llseek,
  fstatat64: _fstatat64,
  fstat64: _fstat64,
  ftruncate64: _ftruncate64,
  ...common_nr
} = wasm32_nr;

// asm-generic __NR3264_* aliases select native LP64 names. lseek takes one
// signed 64-bit offset and returns it; it is not the ILP32 _llseek calling ABI.
export const NR = {
  ...common_nr,
  lseek: 62,
  newfstatat: 79,
  fstat: 80,
  ftruncate: 46,
};

// include/uapi/asm-generic/stat.h, struct stat. The first 72 bytes match
// stat64 on wasm32, but each time/nanosecond member is now eight bytes.
const stat = define_struct(
  "struct stat",
  {
    st_dev: U64LE,
    st_ino: U64LE,
    st_mode: U32LE,
    st_nlink: U32LE,
    st_uid: U32LE,
    st_gid: U32LE,
    st_rdev: U64LE,
    __pad1: U64LE,
    st_size: I64LE,
    st_blksize: I32LE,
    __pad2: I32LE,
    st_blocks: I64LE,
    st_atime: I64LE,
    st_atime_nsec: U64LE,
    st_mtime: I64LE,
    st_mtime_nsec: U64LE,
    st_ctime: I64LE,
    st_ctime_nsec: U64LE,
    __unused4: U32LE,
    __unused5: U32LE,
  },
  { assert_sizeof: true },
);

export const Stat = stat.Schema;
export const stat_size = stat.size;

const replaced_syscalls = new Set([
  "__NR_llseek",
  "__NR_fstatat64",
  "__NR_fstat64",
  "__NR_ftruncate64",
]);

// Reuse checked width-independent flags, errnos, signals, directory records
// and wait macros. Do not duplicate a second unchecked copy of those facts.
export const abi_checks = {
  includes: wasm32_checks.includes,
  scalars: [
    ...wasm32_checks.scalars.filter((entry) => !replaced_syscalls.has(entry.c)),
    ...Object.entries(NR)
      .filter(([name]) => !Object.hasOwn(common_nr, name))
      .map(([name, value]) => ({ c: `__NR_${name}`, value })),
  ],
  structs: [stat.check, ...wasm32_checks.structs.filter((entry) => entry.c !== "struct stat64")],
  exprs: [
    ...wasm32_checks.exprs,
    { name: "LP64 pointer width", expr: "sizeof(void *) == 8" },
    { name: "LP64 long width", expr: "sizeof(long) == 8" },
  ],
};
