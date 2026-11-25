// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// MemoryFs: an in-memory file system to mount in the guest (fs.ts), filled
// from a plain object tree and changed by both sides.
//
//   const fs = new MemoryFs({ "hello.txt": "hi\n", dir: { "a.bin": bytes }, "now.txt": () => new Date().toISOString() });
//   fs.writeFile("/dir/b.txt", "from the host");   // host side
//   fs.onChange((c) => console.log(c.type, c.path)); // what the guest changed
//
// The Fs methods (getattr, open, create, ...) are what the server calls
// for the guest, and changes through them are reported to onChange()
// listeners; the host's own API (writeFile, readFile, rm, ...) has other
// names and reports nothing. A function in the tree is a computed file,
// evaluated once per open: the open file serves that one result (reads and
// its getattr), and the next open evaluates it again; a getattr by path
// evaluates it for the size. It is read-only for the guest, and its
// version is 0 so the guest reads it uncached (its size can change
// between the guest's getattr and its open, and a cached read stops at the
// old size). An open file keeps its node after the path is renamed or
// removed.

import {
  FS_DEFAULT_OWNER,
  FsError,
  fsTime,
  fsTimeNow,
  type FsTime,
  type FsAttr,
  type FsDirEntry,
  type FsFile,
  type Fs,
  type FsOpenFlags,
  type FsSetAttr,
  type FsStatFs,
  type FsIdentity,
  type FsFileType,
} from "./fs.ts";

/** A file's content in a tree: text (UTF-8), bytes, or a function evaluated once per open. */
export type FsTreeFile = string | Uint8Array | (() => string | Uint8Array);
/** A directory as a plain object: names to files or subdirectories. */
export interface FsTree {
  [name: string]: FsTreeFile | FsTree;
}

/** What the guest changed (MemoryFs.onChange). */
export interface MemoryFsChange {
  type:
    | "create"
    | "write"
    | "truncate"
    | "setattr"
    | "mkdir"
    | "symlink"
    | "remove"
    | "rename"
    | "link";
  path: string;
  /** rename/link: the new path; symlink: the target. */
  to?: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const EMPTY = new Uint8Array(0);

interface MemNode {
  ino: number;
  type: FsFileType;
  mode: number;
  uid: number;
  gid: number;
  atime: FsTime;
  mtime: FsTime;
  ctime: FsTime;
  /** Bumped on every data change (FsAttr.version). */
  version: number;
  /** Directory entries pointing at this node. */
  nlink: number;
  data?: Uint8Array;
  /** Valid bytes of `data` (it grows by doubling). */
  size?: number;
  dynamic?: () => string | Uint8Array;
  children?: Map<string, MemNode>;
  target?: string;
  xattrs?: Map<string, Uint8Array>;
}

function parts(path: string): string[] {
  return path.split("/").filter((p) => p && p !== ".");
}

function checkName(name: string, path: string): void {
  if (!name || name === ".." || name.includes("\0"))
    throw new FsError("EINVAL", `bad name in ${JSON.stringify(path)}`);
}

/** An in-memory Fs: a tree the host fills and reads, and the guest reads and writes. */
export class MemoryFs implements Fs {
  #root: MemNode;
  #nextIno = 2;
  #listeners = new Set<(c: MemoryFsChange) => void>();

  /** A file system with `tree`'s files (see FsTree), or empty. */
  constructor(tree?: FsTree) {
    const now = fsTimeNow();
    this.#root = {
      ino: 1,
      type: "dir",
      mode: 0o755,
      uid: FS_DEFAULT_OWNER,
      gid: FS_DEFAULT_OWNER,
      atime: now,
      mtime: now,
      ctime: now,
      version: 1,
      nlink: 2,
      children: new Map(),
    };
    if (tree) this.#fill("", tree);
  }

  #fill(dir: string, tree: FsTree): void {
    for (const [name, v] of Object.entries(tree)) {
      const path = `${dir}/${name}`;
      if (typeof v === "string" || v instanceof Uint8Array || typeof v === "function")
        this.writeFile(path, v);
      else if (v && typeof v === "object") {
        this.mkdirp(path);
        this.#fill(path, v);
      } else
        throw new TypeError(
          `MemoryFs: ${path}: a file is a string, a Uint8Array or a function, a directory an object`,
        );
    }
  }

  /** Call `listener` for every change the guest makes. Returns the unsubscribe function. */
  onChange(listener: (change: MemoryFsChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(type: MemoryFsChange["type"], path: string, to?: string): void {
    for (const l of this.#listeners) {
      try {
        l(to === undefined ? { type, path } : { type, path, to });
      } catch {}
    }
  }

  #lookup(path: string): MemNode {
    let n = this.#root;
    for (const part of parts(path)) {
      if (!n.children) throw new FsError("ENOTDIR", path);
      const c = n.children.get(part);
      if (!c) throw new FsError("ENOENT", path);
      n = c;
    }
    return n;
  }

  #find(path: string): MemNode | undefined {
    try {
      return this.#lookup(path);
    } catch {
      return undefined;
    }
  }

  #dirOf(path: string): { dir: MemNode; name: string } {
    const p = parts(path);
    const name = p.pop();
    if (name === undefined) throw new FsError("EBUSY", "the root");
    checkName(name, path);
    const dir = this.#lookup(p.join("/"));
    if (!dir.children) throw new FsError("ENOTDIR", path);
    return { dir, name };
  }

  #node(type: MemNode["type"], mode: number, extra: Partial<MemNode> = {}): MemNode {
    const now = fsTimeNow();
    return {
      ino: this.#nextIno++,
      type,
      mode,
      uid: FS_DEFAULT_OWNER,
      gid: FS_DEFAULT_OWNER,
      atime: now,
      mtime: now,
      ctime: now,
      version: 1,
      nlink: type === "dir" ? 2 : 1,
      ...extra,
    };
  }

  #touchDir(dir: MemNode): void {
    dir.mtime = dir.ctime = fsTimeNow();
    dir.version++;
  }

  #bytes(n: MemNode): Uint8Array {
    if (n.dynamic) {
      const v = n.dynamic();
      return typeof v === "string" ? enc.encode(v) : v;
    }
    return n.data ? n.data.subarray(0, n.size ?? n.data.length) : EMPTY;
  }

  #changed(n: MemNode): void {
    n.mtime = n.ctime = fsTimeNow();
    n.version++;
  }

  #ensure(n: MemNode, size: number): void {
    const cur = n.data ?? EMPTY;
    if (size <= cur.length) return;
    const b = new Uint8Array(Math.max(size, cur.length * 2, 4096));
    b.set(cur.subarray(0, n.size ?? cur.length));
    n.data = b;
  }

  #writeNode(n: MemNode, offset: number, data: Uint8Array): number {
    if (n.type !== "file") throw new FsError("EISDIR");
    if (n.dynamic) throw new FsError("EACCES");
    this.#ensure(n, offset + data.length);
    n.data!.set(data, offset);
    const size = n.size ?? 0;
    if (offset > size) n.data!.fill(0, size, offset);
    n.size = Math.max(size, offset + data.length);
    this.#changed(n);
    return data.length;
  }

  #truncate(n: MemNode, size: number): void {
    if (n.type !== "file") throw new FsError(n.type === "dir" ? "EISDIR" : "EINVAL");
    if (n.dynamic) throw new FsError("EACCES");
    const old = n.size ?? 0;
    if (size > old) {
      this.#ensure(n, size);
      n.data!.fill(0, old, size);
    }
    n.size = size;
    this.#changed(n);
  }

  /** `size` for a computed file (else it is evaluated for it). */
  #attr(n: MemNode, size?: number): FsAttr {
    size ??=
      n.type === "file"
        ? n.dynamic
          ? this.#bytes(n).length
          : (n.size ?? 0)
        : n.type === "symlink"
          ? enc.encode(n.target!).length
          : n.type === "fifo"
            ? 0
            : 4096;
    return {
      type: n.type,
      mode: n.mode,
      size,
      uid: n.uid,
      gid: n.gid,
      nlink: n.nlink,
      ino: n.ino,
      atime: n.atime,
      mtime: n.mtime,
      ctime: n.ctime,
      version: n.dynamic ? 0 : n.version,
    };
  }

  #setattr(n: MemNode, attr: FsSetAttr): void {
    // Validate and own all selected exact times before changing any metadata.
    const atime =
      attr.atime === undefined ? undefined : fsTime(attr.atime.seconds, attr.atime.nanoseconds);
    const mtime =
      attr.mtime === undefined ? undefined : fsTime(attr.mtime.seconds, attr.mtime.nanoseconds);
    if (attr.size !== undefined) this.#truncate(n, attr.size);
    if (attr.mode !== undefined) n.mode = attr.mode & 0o7777;
    if (attr.uid !== undefined) n.uid = attr.uid;
    if (attr.gid !== undefined) n.gid = attr.gid;
    if (atime !== undefined) n.atime = atime;
    if (mtime !== undefined) {
      n.mtime = mtime;
      n.version++;
    }
    n.ctime = fsTimeNow();
  }

  #unlinkNode(dir: MemNode, name: string, n: MemNode): void {
    dir.children!.delete(name);
    if (n.type === "dir") dir.nlink--;
    n.nlink--;
    n.ctime = fsTimeNow();
    this.#touchDir(dir);
  }

  // --- Host side ---------------------------------------------------------------

  /** Create or replace a file (parent directories are created). A function is evaluated once per open (and by readFile). */
  writeFile(path: string, content: FsTreeFile, opts: { mode?: number } = {}): void {
    const p = parts(path);
    if (p.length > 1) this.mkdirp(p.slice(0, -1).join("/"));
    const { dir, name } = this.#dirOf(path);
    const old = dir.children!.get(name);
    if (old?.type === "dir") throw new FsError("EISDIR", path);
    if (old?.type === "fifo") throw new FsError("EOPNOTSUPP", "FIFO I/O belongs to the Linux VFS");
    const mode = opts.mode ?? old?.mode ?? 0o644;
    if (old && old.type === "file") {
      // Keep the node (inode number, links, open files): the host changed its data.
      old.mode = mode;
      if (typeof content === "function") {
        old.dynamic = content;
        old.data = undefined;
        old.size = 0;
      } else {
        const data = typeof content === "string" ? enc.encode(content) : content.slice();
        old.dynamic = undefined;
        old.data = data;
        old.size = data.length;
      }
      this.#changed(old);
      return;
    }
    const n =
      typeof content === "function"
        ? this.#node("file", mode, { dynamic: content })
        : (() => {
            const data = typeof content === "string" ? enc.encode(content) : content.slice();
            return this.#node("file", mode, { data, size: data.length });
          })();
    if (old) this.#unlinkNode(dir, name, old);
    dir.children!.set(name, n);
    this.#touchDir(dir);
  }

  /** A file's bytes (a copy). */
  readFile(path: string): Uint8Array {
    const n = this.#lookup(path);
    if (n.type !== "file") throw new FsError(n.type === "dir" ? "EISDIR" : "EINVAL", path);
    return this.#bytes(n).slice();
  }

  /** A file's text (UTF-8). */
  readText(path: string): string {
    return dec.decode(this.readFile(path));
  }

  /** Create a directory and its parents (no error if it exists). */
  mkdirp(path: string, opts: { mode?: number } = {}): void {
    let n = this.#root;
    let cur = "";
    for (const part of parts(path)) {
      checkName(part, path);
      cur += `/${part}`;
      let c = n.children!.get(part);
      if (!c) {
        c = this.#node("dir", opts.mode ?? 0o755, { children: new Map() });
        n.children!.set(part, c);
        n.nlink++;
        this.#touchDir(n);
      } else if (c.type !== "dir") throw new FsError("ENOTDIR", cur);
      n = c;
    }
  }

  /** Create a symbolic link at `path` to `target` (parents are created). */
  writeLink(path: string, target: string): void {
    const p = parts(path);
    if (p.length > 1) this.mkdirp(p.slice(0, -1).join("/"));
    const { dir, name } = this.#dirOf(path);
    const old = dir.children!.get(name);
    if (old?.type === "dir") throw new FsError("EISDIR", path);
    if (old) this.#unlinkNode(dir, name, old);
    dir.children!.set(name, this.#node("symlink", 0o777, { target }));
    this.#touchDir(dir);
  }

  /** Remove a file, link or directory (a non-empty directory only with `recursive`; a missing path only with `force`). */
  rm(path: string, opts: { recursive?: boolean; force?: boolean } = {}): void {
    let d: { dir: MemNode; name: string };
    try {
      d = this.#dirOf(path);
    } catch (e) {
      if (opts.force && (e as FsError).code === "ENOENT") return;
      throw e;
    }
    const n = d.dir.children!.get(d.name);
    if (!n) {
      if (opts.force) return;
      throw new FsError("ENOENT", path);
    }
    if (n.children?.size && !opts.recursive) throw new FsError("ENOTEMPTY", path);
    this.#unlinkNode(d.dir, d.name, n);
  }

  /** Move (rename) a file or directory, replacing a file at `to`. */
  move(from: string, to: string): void {
    this.#rename(from, to);
  }

  /** The names in a directory. */
  list(path = "/"): string[] {
    const n = this.#lookup(path);
    if (!n.children) throw new FsError("ENOTDIR", path);
    return [...n.children.keys()];
  }

  /** Attributes of a path (getattr), or undefined if it does not exist. */
  stat(path: string): FsAttr | undefined {
    const n = this.#find(path);
    return n && this.#attr(n);
  }

  exists(path: string): boolean {
    return this.#find(path) !== undefined;
  }

  // --- Fs (the guest's side) -----------------------------------------------------

  getattr(path: string, expected?: FsIdentity): FsAttr {
    return this.#attr(this.#checkedNode(path, expected));
  }

  lookup(directory: string, name: string, expected?: FsIdentity): FsAttr {
    const node = this.#checkedNode(directory, expected);
    if (!node.children) throw new FsError("ENOTDIR", directory);
    if (name === "..") {
      const parent = "/" + parts(directory).slice(0, -1).join("/");
      return this.#attr(this.#lookup(parent));
    }
    if (!name || name === "." || name.includes("/") || name.includes("\0"))
      throw new FsError("EINVAL", name);
    if (enc.encode(name).length > 255) throw new FsError("ENAMETOOLONG", name);
    const child = node.children.get(name);
    if (!child) throw new FsError("ENOENT", name);
    return this.#attr(child);
  }

  readdir(path: string, expected?: FsIdentity): FsDirEntry[] {
    const n = this.#checkedNode(path, expected);
    if (!n.children) throw new FsError("ENOTDIR", path);
    return [...n.children].map(([name, c]) => ({ name, type: c.type, ino: c.ino }));
  }

  readlink(path: string, expected?: FsIdentity): string {
    const n = this.#checkedNode(path, expected);
    if (n.type !== "symlink") throw new FsError("EINVAL", path);
    return n.target!;
  }

  open(path: string, flags: FsOpenFlags): FsFile {
    this.#checkParentIdentity(path, flags.expectedDirectory);
    const n = this.#checkedNode(path, flags.expected);
    if (n.type === "fifo") throw new FsError("EOPNOTSUPP", "FIFO I/O belongs to the Linux VFS");
    if (n.type !== "file") throw new FsError("EISDIR", path);
    if (flags.write && n.dynamic) throw new FsError("EACCES", path);
    if (flags.truncate) {
      this.#truncate(n, 0);
      this.#emit("truncate", path);
    }
    return this.#file(n, path);
  }

  /** An open file on a node: keeps working after renames and removal. `path` is only for the change reports. */
  #file(n: MemNode, path: string): FsFile {
    if (n.dynamic) {
      // A computed file: one evaluation for the life of the open file.
      const b = this.#bytes(n);
      return {
        read: (offset, length) =>
          b.subarray(Math.min(offset, b.length), Math.min(offset + length, b.length)),
        getattr: () => this.#attr(n, b.length),
        setattr: (attr) => {
          this.#setattr(n, attr);
          this.#emit("setattr", path);
        },
      };
    }
    return {
      read: (offset, length) => {
        const b = this.#bytes(n);
        return b.subarray(Math.min(offset, b.length), Math.min(offset + length, b.length));
      },
      write: (offset, data) => {
        const r = this.#writeNode(n, offset, data);
        this.#emit("write", path);
        return r;
      },
      getattr: () => this.#attr(n),
      setattr: (attr) => {
        this.#setattr(n, attr);
        this.#emit(attr.size !== undefined ? "truncate" : "setattr", path);
      },
    };
  }

  create(path: string, mode: number, expectedDirectory?: FsIdentity): FsFile {
    this.#checkParentIdentity(path, expectedDirectory);
    const { dir, name } = this.#dirOf(path);
    if (dir.children!.has(name)) throw new FsError("EEXIST", path);
    const n = this.#node("file", mode & 0o7777, { data: EMPTY, size: 0 });
    dir.children!.set(name, n);
    this.#touchDir(dir);
    this.#emit("create", path);
    return this.#file(n, path);
  }

  mkdir(path: string, mode: number, expectedDirectory?: FsIdentity): void {
    this.#checkParentIdentity(path, expectedDirectory);
    const { dir, name } = this.#dirOf(path);
    if (dir.children!.has(name)) throw new FsError("EEXIST", path);
    dir.children!.set(name, this.#node("dir", mode & 0o7777, { children: new Map() }));
    dir.nlink++;
    this.#touchDir(dir);
    this.#emit("mkdir", path);
  }

  symlink(path: string, target: string, expectedDirectory?: FsIdentity): void {
    this.#checkParentIdentity(path, expectedDirectory);
    const { dir, name } = this.#dirOf(path);
    if (dir.children!.has(name)) throw new FsError("EEXIST", path);
    dir.children!.set(name, this.#node("symlink", 0o777, { target }));
    this.#touchDir(dir);
    this.#emit("symlink", path, target);
  }

  mkfifo(path: string, mode: number, expectedDirectory?: FsIdentity): FsAttr {
    this.#checkParentIdentity(path, expectedDirectory);
    const { dir, name } = this.#dirOf(path);
    if (dir.children!.has(name)) throw new FsError("EEXIST", path);
    const node = this.#node("fifo", mode & 0o7777);
    dir.children!.set(name, node);
    this.#touchDir(dir);
    const created = this.#attr(node);
    this.#emit("create", path);
    return created;
  }

  remove(
    path: string,
    dir: boolean,
    expected?: { source?: FsIdentity; directory?: FsIdentity },
  ): void {
    if (expected?.source) this.#checkedNode(path, expected.source);
    if (expected?.directory)
      this.#checkedNode("/" + parts(path).slice(0, -1).join("/"), expected.directory);
    const d = this.#dirOf(path);
    const n = d.dir.children!.get(d.name);
    if (!n) throw new FsError("ENOENT", path);
    if (dir && n.type !== "dir") throw new FsError("ENOTDIR", path);
    if (!dir && n.type === "dir") throw new FsError("EISDIR", path);
    if (n.children?.size) throw new FsError("ENOTEMPTY", path);
    this.#unlinkNode(d.dir, d.name, n);
    this.#emit("remove", path);
  }

  link(from: string, to: string, expected: { source: FsIdentity; directory: FsIdentity }): void {
    const node = this.#find(from);
    if (
      !node ||
      BigInt(node.ino) !== BigInt(expected.source.ino) ||
      BigInt(expected.source.dev ?? 0) !== 0n
    )
      throw new FsError("ESTALE", from);
    if (node.type === "dir") throw new FsError("EPERM", from);
    // Resolve and compare both objects in this synchronous mutation. A stale
    // directory fid must never direct the new name into a replacement tree.
    let target: { dir: MemNode; name: string };
    try {
      target = this.#dirOf(to);
    } catch (error) {
      if (error instanceof FsError && (error.code === "ENOENT" || error.code === "ENOTDIR"))
        throw new FsError("ESTALE", to);
      throw error;
    }
    if (
      BigInt(target.dir.ino) !== BigInt(expected.directory.ino) ||
      BigInt(expected.directory.dev ?? 0) !== 0n
    )
      throw new FsError("ESTALE", to);
    if (target.dir.children!.has(target.name)) throw new FsError("EEXIST", to);
    target.dir.children!.set(target.name, node);
    node.nlink++;
    node.ctime = fsTimeNow();
    this.#touchDir(target.dir);
    this.#emit("link", from, to);
  }

  rename(
    from: string,
    to: string,
    expected?: {
      source?: FsIdentity;
      sourceDirectory?: FsIdentity;
      destinationDirectory?: FsIdentity;
    },
  ): boolean {
    if (!this.#rename(from, to, expected)) return false;
    this.#emit("rename", from, to);
    return true;
  }

  #rename(
    from: string,
    to: string,
    expected?: {
      source?: FsIdentity;
      sourceDirectory?: FsIdentity;
      destinationDirectory?: FsIdentity;
    },
  ): boolean {
    if (expected?.source) this.#checkedNode(from, expected.source);
    if (expected?.sourceDirectory)
      this.#checkedNode("/" + parts(from).slice(0, -1).join("/"), expected.sourceDirectory);
    if (expected?.destinationDirectory)
      this.#checkedNode("/" + parts(to).slice(0, -1).join("/"), expected.destinationDirectory);
    const a = this.#dirOf(from),
      b = this.#dirOf(to);
    const n = a.dir.children!.get(a.name);
    if (!n) throw new FsError("ENOENT", from);
    if (n.type === "dir") {
      // Not into itself: no directory on the way to `to` may be `n`.
      let p: MemNode = this.#root;
      for (const part of parts(to).slice(0, -1)) {
        if (p === n) break;
        p = p.children!.get(part)!;
      }
      if (p === n) throw new FsError("EINVAL", `${from} into itself`);
    }
    const old = b.dir.children!.get(b.name);
    if (old === n) return false;
    if (old) {
      if (old.type === "dir" && n.type !== "dir") throw new FsError("EISDIR", to);
      if (old.type !== "dir" && n.type === "dir") throw new FsError("ENOTDIR", to);
      if (old.children?.size) throw new FsError("ENOTEMPTY", to);
      this.#unlinkNode(b.dir, b.name, old);
    }
    a.dir.children!.delete(a.name);
    b.dir.children!.set(b.name, n);
    if (n.type === "dir" && a.dir !== b.dir) {
      a.dir.nlink--;
      b.dir.nlink++;
    }
    n.ctime = fsTimeNow();
    this.#touchDir(a.dir);
    if (b.dir !== a.dir) this.#touchDir(b.dir);
    return true;
  }

  #xattrNode(path: string, expected: FsIdentity): MemNode {
    const node = this.#checkedNode(path, expected);
    if (node.type !== "file" && node.type !== "dir") throw new FsError("EOPNOTSUPP");
    return node;
  }

  #xattrName(name: string): void {
    if (!name.startsWith("user.") || name.length === 5) throw new FsError("EOPNOTSUPP");
    if (name.includes("\0")) throw new FsError("EINVAL");
    if (enc.encode(name).length > 255) throw new FsError("ERANGE");
  }

  getxattr(path: string, name: string, expected: FsIdentity): Uint8Array {
    const node = this.#xattrNode(path, expected);
    if (name === "") {
      const names: string[] = [];
      let size = 0;
      for (const entry of node.xattrs?.keys() ?? []) {
        size += enc.encode(entry).length + 1;
        if (size > 65536) throw new FsError("E2BIG");
        names.push(entry);
      }
      return enc.encode(names.length ? names.join("\0") + "\0" : "");
    }
    this.#xattrName(name);
    const value = node.xattrs?.get(name);
    if (!value) throw new FsError("ENODATA");
    return value.slice();
  }

  setxattr(
    path: string,
    name: string,
    value: Uint8Array | null,
    flags: number,
    expected: FsIdentity,
  ): void {
    const node = this.#xattrNode(path, expected);
    this.#xattrName(name);
    if (flags & ~3) throw new FsError("EINVAL");
    const exists = node.xattrs?.has(name) ?? false;
    if (value === null) {
      if (!exists) throw new FsError("ENODATA");
      node.xattrs!.delete(name);
    } else {
      if (value.byteLength > 65536) throw new FsError("E2BIG");
      if (flags & 1 && exists) throw new FsError("EEXIST");
      if (flags & 2 && !exists) throw new FsError("ENODATA");
      const owned = value.slice();
      node.xattrs ??= new Map();
      node.xattrs.set(name, owned);
    }
    node.ctime = fsTimeNow();
    this.#emit("setattr", path);
  }

  #checkParentIdentity(path: string, expected?: FsIdentity): void {
    if (expected) this.#checkedNode("/" + parts(path).slice(0, -1).join("/"), expected);
  }

  #checkedNode(path: string, expected?: FsIdentity): MemNode {
    if (!expected) return this.#lookup(path);
    const node = this.#find(path);
    if (!node || BigInt(node.ino) !== BigInt(expected.ino) || BigInt(expected.dev ?? 0) !== 0n)
      throw new FsError("ESTALE", path);
    return node;
  }

  setattr(path: string, attr: FsSetAttr, expected?: FsIdentity): void {
    this.#setattr(this.#checkedNode(path, expected), attr);
    this.#emit(attr.size !== undefined ? "truncate" : "setattr", path);
  }

  statfs(): FsStatFs {
    let files = 0,
      bytes = 0;
    const walk = (n: MemNode) => {
      files++;
      bytes += n.data?.length ?? 0;
      if (n.children) for (const c of n.children.values()) walk(c);
    };
    walk(this.#root);
    const blocks = Math.max(1 << 18, Math.ceil(bytes / 4096) * 2);
    return {
      bsize: 4096,
      blocks,
      bfree: blocks - Math.ceil(bytes / 4096),
      files: Math.max(1 << 16, files * 2),
      ffree: Math.max(1 << 16, files * 2) - files,
    };
  }
}
