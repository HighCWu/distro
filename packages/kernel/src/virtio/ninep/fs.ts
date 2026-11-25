// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Backend types for the host-side 9P2000.L service. MemoryFs implements
// this interface; host.ts translates ordinary Linux requests into these calls.

type MaybePromise<T> = T | Promise<T>;

/** @internal Linux (asm-generic) errno values by name, for FsError and Node's error codes. */
export const ERRNO: Readonly<Record<string, number>> = {
  EPERM: 1,
  ENOENT: 2,
  EINTR: 4,
  EIO: 5,
  ENXIO: 6,
  E2BIG: 7,
  ENOEXEC: 8,
  EBADF: 9,
  EAGAIN: 11,
  EWOULDBLOCK: 11,
  ENOMEM: 12,
  EACCES: 13,
  EFAULT: 14,
  EBUSY: 16,
  EEXIST: 17,
  EXDEV: 18,
  ENODEV: 19,
  ENOTDIR: 20,
  EISDIR: 21,
  EINVAL: 22,
  ENFILE: 23,
  EMFILE: 24,
  ENOTTY: 25,
  ETXTBSY: 26,
  EFBIG: 27,
  ENOSPC: 28,
  ESPIPE: 29,
  EROFS: 30,
  EMLINK: 31,
  EPIPE: 32,
  ERANGE: 34,
  EDEADLK: 35,
  ENAMETOOLONG: 36,
  ENOLCK: 37,
  ENOSYS: 38,
  ENOTEMPTY: 39,
  ELOOP: 40,
  ENODATA: 61,
  EPROTO: 71,
  EOVERFLOW: 75,
  EILSEQ: 84,
  EOPNOTSUPP: 95,
  ENOTSUP: 95,
  ECONNABORTED: 103,
  ECONNRESET: 104,
  ENOTCONN: 107,
  ETIMEDOUT: 110,
  ESTALE: 116,
  EDQUOT: 122,
  ECANCELED: 125,
};

/** Throw one from a handler to answer the guest with that errno: `code` is its name ("ENOENT"). */
export class FsError extends Error {
  readonly code: string;
  readonly errno: number;
  constructor(code: string, message?: string) {
    super(message === undefined || message === code ? code : `${code}: ${message}`);
    this.name = "FsError";
    this.code = code;
    this.errno = ERRNO[code] ?? ERRNO.EIO!;
  }
}

export type FsFileType = "file" | "dir" | "symlink";

/** Exact Linux timespec64 value; seconds are signed and nsec is normalized. */
export interface FsTime {
  readonly seconds: bigint;
  readonly nanoseconds: number;
}

export function fsTime(seconds: bigint, nanoseconds: number): FsTime {
  if (
    typeof seconds !== "bigint" ||
    seconds < -(1n << 63n) ||
    seconds >= 1n << 63n ||
    !Number.isInteger(nanoseconds) ||
    nanoseconds < 0 ||
    nanoseconds >= 1000000000
  )
    throw new FsError("EINVAL", "invalid Linux timestamp");
  return Object.freeze({ seconds, nanoseconds });
}

export function fsTimeNow(): FsTime {
  const milliseconds = BigInt(Date.now());
  let seconds = milliseconds / 1000n;
  let remainder = milliseconds % 1000n;
  if (remainder < 0n) {
    seconds--;
    remainder += 1000n;
  }
  return fsTime(seconds, Number(remainder) * 1000000);
}

export interface FsAttr {
  type: FsFileType;
  /** Permission bits (default 0o644 files, 0o755 directories, 0o777 links). */
  mode?: number;
  size?: number;
  /** The owner (default FS_DEFAULT_OWNER). */
  uid?: number;
  gid?: number;
  nlink?: number;
  atime?: FsTime;
  mtime?: FsTime;
  ctime?: FsTime;
  /** Inode number (with `dev`). Without it one is derived from the path. */
  ino?: number | bigint;
  /** Device number, combined with `ino` (only needed when one tree spans devices). */
  dev?: number | bigint;
  /**
   * A change counter: changes when the data changes. Default: derived
   * from mtime and size. 0 means the guest never caches this file's
   * data, so each of its reads reaches the file (for computed files,
   * whose size may change).
   */
  version?: number;
}

/**
 * Default uid/gid for backends that omit ownership, and for MemoryFs files
 * until chowned. Linux applies the returned permission bits and ownership.
 */
export const FS_DEFAULT_OWNER = 1000;

export interface FsDirEntry {
  name: string;
  type: FsFileType;
  /** The inode number and device, as getattr gives them (else one is derived from the path). */
  ino?: number | bigint;
  dev?: number | bigint;
}

export interface FsSetAttr {
  mode?: number;
  uid?: number;
  gid?: number;
  size?: number;
  atime?: FsTime;
  mtime?: FsTime;
}

export interface FsStatFs {
  /** Block size (default 4096). */
  bsize?: number;
  blocks?: number;
  bfree?: number;
  /** Default: bfree. */
  bavail?: number;
  files?: number;
  ffree?: number;
  /** Longest name (default 255). */
  namelen?: number;
}

/** How the guest opens a file. */
export interface FsOpenFlags {
  read: boolean;
  write: boolean;
  /** O_TRUNC: truncate to 0 first. */
  truncate: boolean;
  append: boolean;
  /** If present, atomically verify this inode before opening or truncating.
   * A missing/replaced inode must fail ESTALE without applying O_TRUNC. */
  expected?: FsIdentity;
}

/** Stable identity captured by a fid, rather than inferred from its path. */
export interface FsIdentity {
  ino: number | bigint;
  dev?: number | bigint;
}

/**
 * An open file (Fs.open/create), used for the guest's reads, writes,
 * getattr, truncation and fsync until it closes it. It must keep working
 * after the path is renamed or removed. Without `write` the file cannot be
 * opened for writing (EACCES).
 */
export interface FsFile {
  read(offset: number, length: number): MaybePromise<Uint8Array>;
  /** Returns the bytes written. */
  write?(offset: number, data: Uint8Array): MaybePromise<number>;
  getattr?(): MaybePromise<FsAttr>;
  setattr?(attr: FsSetAttr): MaybePromise<void>;
  fsync?(): MaybePromise<void>;
  close?(): MaybePromise<void>;
}

/**
 * A file system by path: every path absolute and normalised ("/" the
 * root, no "." or ".." parts, names never contain "/"). getattr, readdir
 * and open are required. A missing change method answers EROFS (symlink
 * EOPNOTSUPP); hard links are not supported (EPERM). Handlers may be async
 * and throw an FsError, or any Error with an errno `code` as Node's fs
 * errors have, to answer with that errno; anything else is EIO and logged.
 */
export interface Fs {
  getattr(path: string): MaybePromise<FsAttr>;
  readdir(path: string): MaybePromise<FsDirEntry[]>;
  /** Open a regular file. */
  open(path: string, flags: FsOpenFlags): MaybePromise<FsFile>;
  /** Create a regular file (EEXIST if the name exists) and return it open for reading and writing. */
  create?(path: string, mode: number): MaybePromise<FsFile>;
  mkdir?(path: string, mode: number): MaybePromise<void>;
  symlink?(path: string, target: string): MaybePromise<void>;
  readlink?(path: string): MaybePromise<string>;
  /** `dir`: rmdir (ENOTEMPTY unless empty), else unlink. Supplied inode/parent
   * identities must be checked atomically before mutation, or fail ESTALE. */
  remove?(
    path: string,
    dir: boolean,
    expected?: { source?: FsIdentity; directory?: FsIdentity },
  ): MaybePromise<void>;
  /** Atomically verify source and destination-directory identities before
   * adding a name. Missing/replaced objects are ESTALE; no directory links. */
  link?(
    from: string,
    to: string,
    expected: { source: FsIdentity; directory: FsIdentity },
  ): MaybePromise<void>;
  /** Replaces `to` if it exists. Check all supplied identities atomically,
   * even for a no-op. Return false for a same-inode no-op so fid paths stay
   * unchanged; void/true indicate a successful move. */
  rename?(
    from: string,
    to: string,
    expected?: {
      source?: FsIdentity;
      sourceDirectory?: FsIdentity;
      destinationDirectory?: FsIdentity;
    },
  ): MaybePromise<void | boolean>;
  /** Read user.* bytes, or NUL-delimited names when name is empty. Verify
   * the captured inode identity before accessing the attribute storage. */
  getxattr?(path: string, name: string, expected: FsIdentity): MaybePromise<Uint8Array>;
  /** Atomically verify identity and CREATE(1)/REPLACE(2) rules. Null removes
   * an existing attribute. The 9P zero-size convention cannot distinguish
   * removexattr from setting an empty value. */
  setxattr?(
    path: string,
    name: string,
    value: Uint8Array | null,
    flags: number,
    expected: FsIdentity,
  ): MaybePromise<void>;
  /** Change a path that is not open. An empty change updates ctime only.
   * Verify expected atomically before any mutation when it is supplied. */
  setattr?(path: string, attr: FsSetAttr, expected?: FsIdentity): MaybePromise<void>;
  statfs?(): MaybePromise<FsStatFs>;
  /** Called once the last mount of this file system is gone (unmounted, or the VM exited). */
  close?(): MaybePromise<void>;
}
