// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// A 9P2000.L file server on vsock: host-defined file systems in the guest.
//
// Adapted from unkernel 83c65c3cb496737390ed002eceac18de0db1f6a8.
// The Linux client uses ordinary trans=fd over our virtio-vsock listener.
// Exports intentionally accept one connection per export lifetime.
//
// - Framing: size u32 (whole message), type u8, tag u16, then the body;
//   integers little-endian, strings u16 length + UTF-8, a qid is u8 type,
//   u32 version, u64 path. A message within one received chunk is a view of
//   it; one spanning chunks is copied once.
// - Window: at most WINDOW requests run at once per connection; a request
//   holds its slot until its reply is sent, so replies alive at once stay
//   within WINDOW x msize. Up to QUEUE more wait parsed; beyond that the
//   connection stops reading, so vsock credit stops the guest's sends.
//   Control responses have a separate bounded window. Tflush drops a queued
//   request or suppresses a running reply, but cannot bypass unread frames
//   when the normal wait queue is full.
// - Requests run concurrently and are answered as they finish (9P allows
//   any order), except that writes, truncation, fsync and clunk through one
//   fid run in order. A handler that does not settle within the export's
//   timeout (30 s by default) is answered ETIMEDOUT and logged, so a hung
//   handler cannot leave guest processes waiting forever; what it returns
//   later is dropped (an open file is closed).
// - Names are UTF-8: a name that is not (in a walk, create, rename, ...)
//   is answered EILSEQ, never decoded lossily, so two names cannot alias.
// - Inode numbers (qid.path) are the backend's (dev, ino), else a hash of
//   the path. qid.version is the backend's `version`, else from mtime and
//   size; 0 makes the guest read the file uncached (computed files).

type MaybePromise<T> = T | Promise<T>;
import {
  ERRNO,
  FS_DEFAULT_OWNER,
  FsError,
  fsTime,
  fsTimeNow,
  type FsTime,
  type Fs,
  type FsAttr,
  type FsDirEntry,
  type FsFile,
  type FsFileType,
  type FsSetAttr,
  type FsIdentity,
} from "./fs.ts";
import {
  vsockConnectionClosed,
  vsockConnectionReset,
  type VsockConnection,
  type VsockDevice,
  type VsockListener,
} from "../vsock.ts";
export { MemoryFs } from "./memfs.ts";
export type { Fs } from "./fs.ts";
interface MountStats {
  requests: number;
  errors: number;
  bytesRead: number;
  bytesWritten: number;
}

/** The conventional 9P server port. */
export const P9_PORT = 564;
/** The largest offered message size, including its header. */
const MSIZE = 128 * 1024;
/** How long a handler may take before the guest gets ETIMEDOUT, in ms (MountOptions.requestTimeout). */
const DEFAULT_TIMEOUT = 30000;
const P9_VERSION = "9P2000.L";
const HDR = 7;
/** Requests running at once per connection. */
const WINDOW = 16;
/** Requests parsed and waiting for a slot before the connection stops reading. */
const QUEUE = 16;

// Message types (9P2000.L); a reply is the request's type + 1.
const Rlerror = 7,
  Tstatfs = 8,
  Tlopen = 12,
  Tlcreate = 14,
  Tsymlink = 16,
  Tmknod = 18,
  Trename = 20,
  Treadlink = 22,
  Tgetattr = 24,
  Tsetattr = 26,
  Txattrwalk = 30,
  Txattrcreate = 32,
  Treaddir = 40,
  Tfsync = 50,
  Tlock = 52,
  Tgetlock = 54,
  Tlink = 70,
  Tmkdir = 72,
  Trenameat = 74,
  Tunlinkat = 76,
  Tversion = 100,
  Tauth = 102,
  Tattach = 104,
  Tflush = 108,
  Twalk = 110,
  Tread = 116,
  Twrite = 118,
  Tclunk = 120,
  Tremove = 122;

const QTDIR = 0x80,
  QTSYMLINK = 0x02,
  QTFILE = 0;
const S_IFDIR = 0o040000,
  S_IFREG = 0o100000,
  S_IFLNK = 0o120000;
const DT_DIR = 4,
  DT_REG = 8,
  DT_LNK = 10;
const AT_REMOVEDIR = 0x200;
const O_ACCMODE = 3,
  O_EXCL = 0o200,
  O_TRUNC = 0o1000,
  O_APPEND = 0o2000;
const P9_STATS_BASIC = 0x7ff;
const V9FS_MAGIC = 0x01021997;

/** The errno for a handler's error (an FsError, or an Error with a known `code` as Node's have), else 0. */
function knownErrno(e: unknown): number {
  if (e instanceof FsError) return e.errno;
  const code = (e as { code?: unknown } | null)?.code;
  return (typeof code === "string" && ERRNO[code]) || 0;
}

/** One export is bound to its first connection for its lifetime. Add a new
 * export to mount the same backend again after disconnecting. */
export interface NinepExport {
  readonly name: string;
  readonly connected: boolean;
  onConnection?: (connected: boolean) => void;
}
export interface NinepServer {
  add(fs: Fs, opts?: { readOnly?: boolean; timeout?: number }): NinepExport;
  close(): void;
}
/** Internal host-side 9P2000.L service over the existing virtio-vsock device. */
export function serveNinep(
  vsock: Pick<VsockDevice, "listen">,
  options: { port?: number; log?: (message: string) => void } = {},
): NinepServer {
  return new Server(vsock, options.port ?? P9_PORT, options.log ?? (() => {}));
}

// --- Encoding -----------------------------------------------------------------

const enc = new TextEncoder();
const lenient = new TextDecoder();
const strict = new TextDecoder("utf-8", { fatal: true });

class Writer {
  buf: Uint8Array;
  dv: DataView;
  n = HDR;
  constructor(size = 64) {
    this.buf = new Uint8Array(Math.max(size, HDR));
    this.dv = new DataView(this.buf.buffer);
  }
  room(k: number): void {
    if (this.n + k <= this.buf.length) return;
    const b = new Uint8Array(Math.max(this.buf.length * 2, this.n + k));
    b.set(this.buf.subarray(0, this.n));
    this.buf = b;
    this.dv = new DataView(b.buffer);
  }
  u8(v: number): this {
    this.room(1);
    this.dv.setUint8(this.n, v);
    this.n += 1;
    return this;
  }
  u16(v: number): this {
    this.room(2);
    this.dv.setUint16(this.n, v, true);
    this.n += 2;
    return this;
  }
  u32(v: number): this {
    this.room(4);
    this.dv.setUint32(this.n, v >>> 0, true);
    this.n += 4;
    return this;
  }
  u64(v: number | bigint): this {
    this.room(8);
    this.dv.setBigUint64(
      this.n,
      typeof v === "bigint" ? BigInt.asUintN(64, v) : BigInt(Math.max(0, Math.floor(v))),
      true,
    );
    this.n += 8;
    return this;
  }
  str(s: string): this {
    const b = enc.encode(s);
    this.u16(b.length);
    return this.bytes(b);
  }
  bytes(b: Uint8Array): this {
    this.room(b.length);
    this.buf.set(b, this.n);
    this.n += b.length;
    return this;
  }
  qid(q: Qid): this {
    return this.u8(q.type).u32(q.version).u64(q.path);
  }
  finish(type: number, tag: number): Uint8Array {
    this.dv.setUint32(0, this.n, true);
    this.dv.setUint8(4, type);
    this.dv.setUint16(5, tag, true);
    return this.buf.subarray(0, this.n);
  }
}

class Reader {
  at = HDR;
  readonly dv: DataView;
  readonly buf: Uint8Array;
  constructor(buf: Uint8Array) {
    this.buf = buf;
    this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  u8(): number {
    const v = this.dv.getUint8(this.at);
    this.at += 1;
    return v;
  }
  u16(): number {
    const v = this.dv.getUint16(this.at, true);
    this.at += 2;
    return v;
  }
  u32(): number {
    const v = this.dv.getUint32(this.at, true);
    this.at += 4;
    return v;
  }
  u64(): bigint {
    const v = this.dv.getBigUint64(this.at, true);
    this.at += 8;
    return v;
  }
  /** A string where bad UTF-8 does no harm (user and attach names). */
  str(): string {
    return lenient.decode(this.bytes(this.u16()));
  }
  /** A file name or link target: EILSEQ unless valid UTF-8. */
  name(): string {
    try {
      return strict.decode(this.bytes(this.u16()));
    } catch (e) {
      if (e instanceof FsError) throw e;
      throw new FsError("EILSEQ", "a name that is not UTF-8");
    }
  }
  bytes(n: number): Uint8Array {
    if (this.at + n > this.buf.length)
      throw new FsError("EPROTO", "a message shorter than its fields");
    const b = this.buf.subarray(this.at, this.at + n);
    this.at += n;
    return b;
  }
}

function filePosition(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new FsError("EOVERFLOW");
  return Number(value);
}

const typeOf = (frame: Uint8Array) => frame[4]!;
const tagOf = (frame: Uint8Array) => frame[5]! | (frame[6]! << 8);
const errorReply = (tag: number, errno: number) =>
  new Writer(HDR + 4).u32(errno).finish(Rlerror, tag);

/** @internal Splits a byte stream into 9p messages however it is chunked. A message within one chunk is a view of it, else one copy. */
export class P9FrameAssembler {
  #chunks: Uint8Array[] = [];
  #head = 0;
  #len = 0;
  readonly maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  /** Bytes received and not yet taken as messages. */
  get buffered(): number {
    return this.#len;
  }

  push(chunk: Uint8Array): void {
    if (chunk.length) {
      this.#chunks.push(chunk);
      this.#len += chunk.length;
    }
  }

  /** The next whole message, or undefined. Throws on a size outside 7..maxSize. */
  next(): Uint8Array | undefined {
    if (this.#len < 4) return undefined;
    let size = 0;
    for (let i = 0, c = 0, off = this.#head; i < 4;) {
      const chunk = this.#chunks[c]!;
      if (off >= chunk.length) {
        c++;
        off = 0;
        continue;
      }
      size |= chunk[off++]! << (8 * i++);
    }
    size >>>= 0;
    if (size < HDR || size > this.maxSize)
      throw new Error(`a 9p message of ${size} bytes (at most ${this.maxSize})`);
    if (this.#len < size) return undefined;
    const first = this.#chunks[0]!;
    let out: Uint8Array;
    if (first.length - this.#head >= size) {
      out = first.subarray(this.#head, this.#head + size);
      this.#head += size;
    } else {
      out = new Uint8Array(size);
      for (let at = 0; at < size;) {
        const c = this.#chunks[0]!;
        const k = Math.min(size - at, c.length - this.#head);
        out.set(c.subarray(this.#head, this.#head + k), at);
        at += k;
        this.#head += k;
        if (this.#head === c.length) {
          this.#chunks.shift();
          this.#head = 0;
        }
      }
    }
    if (this.#chunks.length && this.#head === this.#chunks[0]!.length) {
      this.#chunks.shift();
      this.#head = 0;
    }
    this.#len -= size;
    return out;
  }
}

interface Qid {
  type: number;
  version: number;
  path: number | bigint;
}

function join(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

function parent(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

function checkName(name: string): void {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\0"))
    throw new FsError("EINVAL", `bad name ${JSON.stringify(name)}`);
  if (enc.encode(name).length > 255) throw new FsError("ENAMETOOLONG");
}

/** `path` is `prefix` or inside it. */
function under(path: string, prefix: string): boolean {
  return (
    prefix === "/" || path === prefix || (path.startsWith(prefix) && path[prefix.length] === "/")
  );
}

/** qid.path: the backend's (dev, ino), else a 63-bit hash of the path with the top bit set (two FNV-1a). */
function inode(
  path: string,
  ino: number | bigint | undefined,
  dev: number | bigint | undefined,
): number | bigint {
  if (ino !== undefined)
    return dev !== undefined && dev !== 0 && dev !== 0n
      ? BigInt.asUintN(64, (BigInt(dev) << 40n) ^ BigInt(ino))
      : ino;
  let a = 0x811c9dc5,
    b = 0x050c5d1f;
  for (let i = 0; i < path.length; i++) {
    const c = path.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x01000193) ^ (b >>> 15);
  }
  return (1n << 63n) | (BigInt((a >>> 1) | 0x40000000) << 32n) | BigInt(b >>> 0);
}

const qidType = (t: FsFileType) => (t === "dir" ? QTDIR : t === "symlink" ? QTSYMLINK : QTFILE);

function qidOf(path: string, a: FsAttr): Qid {
  let version = a.version;
  if (version === undefined) {
    const t = Number(
      BigInt.asUintN(
        32,
        (a.mtime?.seconds ?? 0n) * 1000000000n + BigInt(a.mtime?.nanoseconds ?? 0),
      ),
    );
    version = (t ^ Math.imul((a.size ?? 0) % 0x100000000, 0x9e3779b1)) >>> 0 || 1;
  }
  return { type: qidType(a.type), version: version >>> 0, path: inode(path, a.ino, a.dev) };
}

const MSG_NAMES: Record<number, string> = {
  [Tstatfs]: "statfs",
  [Tlopen]: "lopen",
  [Tlcreate]: "lcreate",
  [Tsymlink]: "symlink",
  [Tmknod]: "mknod",
  [Trename]: "rename",
  [Treadlink]: "readlink",
  [Tgetattr]: "getattr",
  [Tsetattr]: "setattr",
  [Treaddir]: "readdir",
  [Tfsync]: "fsync",
  [Tlink]: "link",
  [Tmkdir]: "mkdir",
  [Trenameat]: "renameat",
  [Tunlinkat]: "unlinkat",
  [Tattach]: "attach",
  [Twalk]: "walk",
  [Tread]: "read",
  [Twrite]: "write",
  [Tclunk]: "clunk",
  [Tremove]: "remove",
};

/** Requests a read-only export answers with EROFS (Tlopen only with write or truncate flags; Tremove apart). */
const MUTATING = new Set([
  Tlcreate,
  Tsymlink,
  Tmknod,
  Trename,
  Tsetattr,
  Txattrcreate,
  Tlink,
  Tmkdir,
  Trenameat,
  Tunlinkat,
  Twrite,
]);

// --- Server and bounded connections -------------------------------------------

class Export implements NinepExport {
  readonly server: Server;
  readonly name: string;
  readonly fs: Fs;
  readonly readOnly: boolean;
  readonly timeout: number;
  readonly stats: MountStats = { requests: 0, errors: 0, bytesRead: 0, bytesWritten: 0 };
  conn: Connection | undefined;
  connected = false;
  onConnection: ((connected: boolean) => void) | undefined;
  removed = false;
  constructor(server: Server, name: string, fs: Fs, readOnly: boolean, timeout: number) {
    this.server = server;
    this.name = name;
    this.fs = fs;
    this.readOnly = readOnly;
    this.timeout = timeout;
  }
  opened(connection: Connection, open: boolean): void {
    if (open) this.conn = connection;
    else if (this.conn !== connection || !this.connected) return;
    this.connected = open;
    try {
      this.onConnection?.(open);
    } catch (error) {
      this.server.log(`[9p] connection observer: ${String(error)}`);
    }
  }
  remove(): void {
    if (this.removed) return;
    this.removed = true;
    this.conn?.reset();
    this.onConnection = undefined;
    this.server.forget(this);
  }
}

class Server implements NinepServer {
  readonly log: (message: string) => void;
  #listener: VsockListener;
  #exports = new Map<string, Export>();
  #users = new Map<Fs, number>();
  #connections = new Set<Connection>();
  #next = 1;
  #closed = false;
  constructor(vsock: Pick<VsockDevice, "listen">, port: number, log: (message: string) => void) {
    this.log = (message) => {
      try {
        log(message);
      } catch {}
    };
    this.#listener = vsock.listen(port);
    void this.#accept().catch((error) => {
      this.log(`[9p] accept: ${String(error)}`);
      this.close();
    });
  }
  async #accept(): Promise<void> {
    for (;;) {
      const raw = await this.#listener.accept();
      if (!raw) return;
      if (this.#closed) {
        vsockConnectionReset(raw);
        return;
      }
      const connection = new Connection(this, raw);
      this.#connections.add(connection);
      void connection.run().finally(() => this.#connections.delete(connection));
    }
  }
  add(fs: Fs, opts: { readOnly?: boolean; timeout?: number } = {}): NinepExport {
    if (this.#closed) throw new FsError("ECONNABORTED", "the 9p server is closed");
    const timeout = opts.timeout ?? DEFAULT_TIMEOUT;
    if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 0x7fffffff)
      throw new RangeError("9p request timeout must be a nonnegative timer duration");
    const entry = new Export(this, `fs${this.#next++}`, fs, !!opts.readOnly, timeout);
    this.#exports.set(entry.name, entry);
    this.#users.set(fs, (this.#users.get(fs) ?? 0) + 1);
    return entry;
  }
  get(name: string): Export | undefined {
    return this.#closed ? undefined : this.#exports.get(name);
  }
  forget(entry: Export): void {
    if (this.#exports.get(entry.name) !== entry) return;
    this.#exports.delete(entry.name);
    const users = (this.#users.get(entry.fs) ?? 1) - 1;
    if (users > 0) {
      this.#users.set(entry.fs, users);
      return;
    }
    this.#users.delete(entry.fs);
    Promise.resolve()
      .then(() => entry.fs.close?.())
      .catch((error) => this.log(`[9p] close: ${String(error)}`));
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#listener.close();
    for (const entry of [...this.#exports.values()]) entry.remove();
    for (const connection of [...this.#connections]) connection.reset();
  }
}

interface QueuedRequest {
  frame: Uint8Array;
  tag: number;
  flushed: boolean;
}
const CONTROL_WINDOW = 16;
const MAX_PARSE_BURST = WINDOW + QUEUE + CONTROL_WINDOW;

class Connection {
  #server: Server;
  #conn: VsockConnection;
  #asm = new P9FrameAssembler(MSIZE);
  #msize = MSIZE;
  #session: Session | undefined;
  #queue: QueuedRequest[] = [];
  #tags = new Map<number, QueuedRequest>();
  #inFlight = 0;
  #controls = 0;
  #wake: (() => void) | undefined;
  #done = false;
  constructor(server: Server, connection: VsockConnection) {
    this.#server = server;
    this.#conn = connection;
    void vsockConnectionClosed(connection).then(() => this.#finish(false));
  }
  #finish(reset: boolean): void {
    if (this.#done) return;
    this.#done = true;
    if (reset) vsockConnectionReset(this.#conn);
    else this.#conn.close();
    this.#queue = [];
    this.#tags.clear();
    this.#wake?.();
    this.#wake = undefined;
    this.#session?.destroy();
    this.#session?.exp.opened(this, false);
  }
  reset(): void {
    this.#finish(true);
  }
  async run(): Promise<void> {
    try {
      while (!this.#done) {
        // No speculative reads: retain only the current bounded transport
        // chunk while a full normal wait queue applies backpressure.
        const chunk = await this.#conn.read();
        if (this.#done || chunk.byteLength === 0) break;
        this.#asm.push(chunk);
        let parsed = 0;
        for (;;) {
          while (this.#queue.length >= QUEUE && !this.#done) {
            await new Promise<void>((resolve) => {
              this.#wake = resolve;
            });
            parsed = 0;
          }
          if (this.#done) break;
          const frame = this.#asm.next();
          if (!frame) break;
          if (++parsed > MAX_PARSE_BURST) {
            await Promise.resolve();
            parsed = 0;
          }
          this.#frame(frame);
        }
      }
    } catch (error) {
      this.#server.log(
        `[9p] ${this.#session?.exp.name ?? "connection"}: ${String(error)}; resetting`,
      );
      this.reset();
    } finally {
      this.#finish(false);
    }
  }
  async #send(frame: Uint8Array): Promise<void> {
    if (this.#done) return;
    const stats = this.#session?.exp.stats;
    if (stats) {
      if (typeOf(frame) === Rlerror) stats.errors++;
      else if (typeOf(frame) === Tread + 1) stats.bytesRead += frame.length - HDR - 4;
    }
    // The request owns its slot until this credit-controlled write settles.
    await this.#conn.write(frame);
  }
  #control(frame: Uint8Array, tag: number, flushed?: QueuedRequest): void {
    if (this.#controls >= CONTROL_WINDOW || this.#tags.has(tag))
      throw new Error("9p control response window exhausted or duplicate tag");
    const token = { frame, tag, flushed: false };
    this.#tags.set(tag, token);
    this.#controls++;
    void this.#send(frame)
      .catch(() => this.reset())
      .finally(() => {
        this.#controls--;
        if (this.#tags.get(tag) === token) this.#tags.delete(tag);
        if (flushed && this.#tags.get(flushed.tag) === flushed) this.#tags.delete(flushed.tag);
      });
  }
  #frame(frame: Uint8Array): void {
    if (frame.byteLength > this.#msize) throw new Error("9p request exceeds negotiated msize");
    const type = typeOf(frame),
      tag = tagOf(frame);
    const session = this.#session;
    if (session) session.exp.stats.requests++;
    if (type === Tflush) {
      if (frame.length !== HDR + 2) throw new Error("invalid 9p flush request");
      const old = frame[HDR]! | (frame[HDR + 1]! << 8);
      if (old === tag) throw new Error("9p flush references its own tag");
      const token = this.#tags.get(old);
      if (token) {
        token.flushed = true;
        const index = this.#queue.indexOf(token);
        if (index >= 0) this.#queue.splice(index, 1);
        else session?.flush(old);
      }
      this.#control(new Writer(HDR).finish(Tflush + 1, tag), tag, token);
      this.#pump();
      return;
    }
    if (!session && type === Tversion) {
      let reply: Uint8Array;
      try {
        const reader = new Reader(frame);
        this.#msize = Math.max(4096, Math.min(reader.u32(), MSIZE));
        const version = reader.str();
        reply = new Writer(32)
          .u32(this.#msize)
          .str(version.startsWith(P9_VERSION) ? P9_VERSION : "unknown")
          .finish(Tversion + 1, tag);
      } catch {
        reply = errorReply(tag, ERRNO.EPROTO!);
      }
      this.#control(reply, tag);
      return;
    }
    if (!session && type === Tattach) {
      let entry: Export | undefined;
      try {
        const reader = new Reader(frame);
        reader.u32();
        reader.u32();
        reader.str();
        entry = this.#server.get(reader.str());
      } catch {}
      if (!entry || entry.removed) {
        this.#control(errorReply(tag, ERRNO.ENOENT!), tag);
        return;
      }
      if (entry.conn) {
        this.#control(errorReply(tag, ERRNO.EBUSY!), tag);
        return;
      }
      this.#session = new Session(entry, this.#msize);
      entry.opened(this, true);
      entry.stats.requests++;
      if (this.#done) return;
    } else if (!session) {
      this.#control(errorReply(tag, type === Tauth ? ERRNO.EOPNOTSUPP! : ERRNO.EBADF!), tag);
      return;
    }
    if (this.#tags.has(tag) || this.#queue.length >= QUEUE)
      throw new Error("9p request window exhausted or duplicate tag");
    const request = { frame, tag, flushed: false };
    this.#tags.set(tag, request);
    this.#queue.push(request);
    this.#pump();
  }
  #pump(): void {
    while (!this.#done && this.#session && this.#inFlight < WINDOW && this.#queue.length) {
      const request = this.#queue.shift()!;
      this.#inFlight++;
      const call = this.#session.call(request.frame);
      void Promise.all([
        call.reply.then(async (reply) => {
          if (reply && !request.flushed) await this.#send(reply);
          if (!request.flushed && this.#tags.get(request.tag) === request)
            this.#tags.delete(request.tag);
        }),
        // Flush/timeout may release the reply, but must not admit infinitely many
        // still-running backend calls. Keep its slot until the handler settles.
        call.finished,
      ])
        .catch(() => this.reset())
        .finally(() => {
          this.#inFlight--;
          if (!request.flushed && this.#tags.get(request.tag) === request)
            this.#tags.delete(request.tag);
          this.#pump();
        });
    }
    if (this.#queue.length < QUEUE) {
      const wake = this.#wake;
      this.#wake = undefined;
      wake?.();
    }
  }
}

// --- A protocol session over an Fs ------------------------------------------------

interface Fid {
  path: string;
  type: FsFileType;
  identity?: FsIdentity;
  /** The open file (Tlopen/Tlcreate of a regular file). */
  file?: FsFile;
  /** Directory listing taken at readdir offset 0 (with . and ..). */
  dir?: FsDirEntry[];
  /** Writes, truncation, fsync and clunk through this fid run in order. */
  chain: Promise<unknown>;
}

function fileOf(f: Fid): FsFile | undefined {
  return f.file;
}

function identityOf(attr: FsAttr): FsIdentity | undefined {
  const valid = (value: number | bigint) =>
    typeof value === "bigint" ? value >= 0n : Number.isSafeInteger(value) && value >= 0;
  if (attr.ino === undefined || !valid(attr.ino) || (attr.dev !== undefined && !valid(attr.dev)))
    return undefined;
  return { ino: attr.ino, ...(attr.dev === undefined ? {} : { dev: attr.dev }) };
}

function matchesIdentity(attr: FsAttr, expected: FsIdentity): boolean {
  const actual = identityOf(attr);
  return (
    actual !== undefined &&
    BigInt(actual.ino) === BigInt(expected.ino) &&
    BigInt(actual.dev ?? 0) === BigInt(expected.dev ?? 0)
  );
}

function explicitTime(seconds: bigint, nanoseconds: bigint): FsTime {
  if (nanoseconds >= 1000000000n) throw new FsError("EINVAL", "invalid timestamp nanoseconds");
  return fsTime(BigInt.asIntN(64, seconds), Number(nanoseconds));
}

/** A running request: `dead` once it was flushed or timed out (its result is dropped). */
interface Pending {
  dead: boolean;
  resolve: (r: Uint8Array | null) => void;
  timer?: ReturnType<typeof setTimeout>;
}

class Session {
  readonly exp: Export;
  #fs: Fs;
  #fids = new Map<number, Fid>();
  #msize: number;
  #pending = new Map<number, Pending>();
  #destroyed = false;

  constructor(exp: Export, msize: number) {
    this.exp = exp;
    this.#fs = exp.fs;
    this.#msize = msize;
  }

  get msize(): number {
    return this.#msize;
  }

  #log(msg: string): void {
    this.exp.server.log(`[9p] ${this.exp.name}: ${msg}`);
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    for (const p of this.#pending.values()) {
      p.dead = true;
      clearTimeout(p.timer);
      p.resolve(null);
    }
    this.#pending.clear();
    for (const f of this.#fids.values()) this.#closeFile(f);
    this.#fids.clear();
  }

  /** Tflush of a running request: its reply is dropped and its slot freed. */
  flush(tag: number): void {
    const p = this.#pending.get(tag);
    if (!p) return;
    p.dead = true;
    clearTimeout(p.timer);
    this.#pending.delete(tag);
    p.resolve(null);
  }

  #closeFile(f: Fid): void {
    const file = f.file;
    f.file = undefined;
    if (file?.close)
      void this.#ordered(f, () => file.close!()).catch((e) => this.#failed("close", e));
  }

  #failed(what: string, e: unknown): number {
    const n = knownErrno(e);
    if (!n) this.#log(`${what}: ${(e as Error)?.stack ?? e}`);
    return n || ERRNO.EIO!;
  }

  call(frame: Uint8Array): { reply: Promise<Uint8Array | null>; finished: Promise<void> } {
    const type = typeOf(frame),
      tag = tagOf(frame);
    if (this.#destroyed) return { reply: Promise.resolve(null), finished: Promise.resolve() };
    let finished!: () => void;
    const completion = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const reply = new Promise<Uint8Array | null>((resolve) => {
      const state: Pending = { dead: false, resolve };
      this.#pending.set(tag, state);
      const timeout = this.exp.timeout;
      if (timeout > 0)
        state.timer = setTimeout(() => {
          if (state.dead) return;
          state.dead = true;
          this.#pending.delete(tag);
          this.#log(
            `${MSG_NAMES[type] ?? type}: the handler did not answer within ${timeout} ms; the guest gets ETIMEDOUT`,
          );
          resolve(errorReply(tag, ERRNO.ETIMEDOUT!));
        }, timeout);
      let run: Promise<Writer>;
      try {
        run = this.#handle(type, new Reader(frame), state);
      } catch (e) {
        run = Promise.reject(e);
      }
      run
        .then(
          (w) => w.finish(type + 1, tag),
          (e) => errorReply(tag, this.#failed(MSG_NAMES[type] ?? String(type), e)),
        )
        .then(
          (reply) => {
            clearTimeout(state.timer);
            if (this.#pending.get(tag) === state) this.#pending.delete(tag);
            if (!state.dead) resolve(reply);
          },
          (error) => {
            clearTimeout(state.timer);
            if (this.#pending.get(tag) === state) this.#pending.delete(tag);
            if (!state.dead) resolve(errorReply(tag, this.#failed("reply", error)));
          },
        )
        .finally(finished);
    });
    return { reply, finished: completion };
  }

  #fid(n: number): Fid {
    const f = this.#fids.get(n);
    if (!f) throw new FsError("EBADF", `unknown fid ${n}`);
    return f;
  }

  /** A fid that must be a directory (names are made below it, so never below a symlink). */
  #dir(n: number): Fid {
    const f = this.#fid(n);
    if (f.type !== "dir") throw new FsError("ENOTDIR");
    return f;
  }

  /** Run `op` after the fid's earlier ordered operations; a hung one holds the next back for at most the timeout. */
  #ordered<T>(f: Fid, op: () => MaybePromise<T>): Promise<T> {
    const p = f.chain.then(op);
    const t = this.exp.timeout;
    let timer: ReturnType<typeof setTimeout> | undefined;
    f.chain = (t > 0 ? Promise.race([p, new Promise((r) => (timer = setTimeout(r, t)))]) : p)
      .catch(() => {})
      .finally(() => clearTimeout(timer));
    return p;
  }

  #need<K extends keyof Fs>(k: K, code = "EROFS"): NonNullable<Fs[K]> {
    const fn = this.#fs[k];
    if (typeof fn !== "function") throw new FsError(code);
    return (fn as (...a: never[]) => unknown).bind(this.#fs) as NonNullable<Fs[K]>;
  }

  /** Open a regular file for a fid; one opened after the request died is closed again. */
  async #open(f: Fid, state: Pending, file: MaybePromise<FsFile>, write: boolean): Promise<FsFile> {
    const opened = await file;
    if (state.dead || (write && !opened.write)) {
      await opened.close?.();
      if (!state.dead) throw new FsError("EACCES", `${f.path}: not writable`);
    } else {
      if (f.file) this.#closeFile(f);
      f.file = opened;
    }
    return opened;
  }

  /** A rename in this tree: fids below `from` follow it. */
  #renamed(from: string, to: string): void {
    for (const f of this.#fids.values())
      if (under(f.path, from)) f.path = to + f.path.slice(from.length);
  }

  async #handle(type: number, r: Reader, state: Pending): Promise<Writer> {
    const fs = this.#fs;
    if (this.exp.readOnly) {
      const flags =
        type === Tlopen ? new DataView(r.buf.buffer, r.buf.byteOffset).getUint32(HDR + 4, true) : 0;
      if (MUTATING.has(type) || (type === Tlopen && (flags & O_ACCMODE || flags & O_TRUNC)))
        throw new FsError("EROFS");
      if (type === Tremove) {
        // The fid goes away as Tremove's would, and the answer is EROFS.
        const n = r.u32();
        const f = this.#fid(n);
        this.#fids.delete(n);
        this.#closeFile(f);
        throw new FsError("EROFS");
      }
    }
    switch (type) {
      case Tversion: {
        // A second Tversion: a new session on this connection.
        const msize = r.u32();
        const version = r.str();
        this.#msize = Math.max(4096, Math.min(msize, this.#msize));
        for (const f of this.#fids.values()) this.#closeFile(f);
        this.#fids.clear();
        return new Writer(32)
          .u32(this.#msize)
          .str(version.startsWith(P9_VERSION) ? P9_VERSION : "unknown");
      }
      case Tauth:
        throw new FsError("EOPNOTSUPP");
      case Tattach: {
        // The guest attaches again for each uid it acts as (access=client), naming the same file system.
        const fid = r.u32();
        (r.u32(), r.str());
        if (r.str() !== this.exp.name)
          throw new FsError("ENOENT", "an attach to another file system on this connection");
        const a = await fs.getattr("/");
        if (a.type !== "dir")
          throw new FsError("ENOTDIR", "the file system's root is not a directory");
        if (!state.dead)
          this.#fids.set(fid, {
            path: "/",
            type: "dir",
            identity: identityOf(a),
            chain: Promise.resolve(),
          });
        return new Writer(HDR + 13).qid(qidOf("/", a));
      }
      case Twalk: {
        const fid = r.u32(),
          newfid = r.u32(),
          n = r.u16();
        const f = this.#fid(fid);
        let path = f.path,
          ftype = f.type;
        let identity = f.identity;
        const qids: Qid[] = [];
        for (let i = 0; i < n; i++) {
          let a: FsAttr;
          try {
            const name = r.name();
            if (ftype !== "dir") throw new FsError("ENOTDIR");
            const next = name === ".." ? parent(path) : (checkName(name), join(path, name));
            a = await fs.getattr(next);
            path = next;
          } catch (e) {
            if (i === 0) throw e;
            break;
          }
          qids.push(qidOf(path, a));
          ftype = a.type;
          identity = identityOf(a);
        }
        if (qids.length === n && !state.dead) {
          // A fid replaced here (newfid in use, or walked in place) closes its open file.
          const old = this.#fids.get(newfid);
          if (old) this.#closeFile(old);
          this.#fids.set(newfid, {
            path,
            type: ftype,
            identity,
            chain: old?.chain ?? Promise.resolve(),
          });
        }
        const w = new Writer(HDR + 2 + 13 * qids.length).u16(qids.length);
        for (const q of qids) w.qid(q);
        return w;
      }
      case Tclunk:
      case Tremove: {
        const n = r.u32();
        const f = this.#fid(n);
        this.#fids.delete(n);
        const file = f.file;
        f.file = undefined;
        await this.#ordered(f, () => file?.close?.());
        if (type === Tremove) {
          if (f.path === "/") throw new FsError("EBUSY");
          await this.#need("remove")(f.path, f.type === "dir");
        }
        return new Writer(HDR);
      }
      case Tstatfs: {
        this.#fid(r.u32());
        const s = (await fs.statfs?.()) ?? {};
        return new Writer(HDR + 60)
          .u32(V9FS_MAGIC)
          .u32(s.bsize ?? 4096)
          .u64(s.blocks ?? 0)
          .u64(s.bfree ?? 0)
          .u64(s.bavail ?? s.bfree ?? 0)
          .u64(s.files ?? 0)
          .u64(s.ffree ?? 0)
          .u64(0)
          .u32(s.namelen ?? 255);
      }
      case Tlopen: {
        const f = this.#fid(r.u32());
        const flags = r.u32();
        const write = (flags & O_ACCMODE) !== 0;
        let a = await fs.getattr(f.path);
        if (f.identity && !matchesIdentity(a, f.identity)) throw new FsError("ESTALE", f.path);
        f.type = a.type;
        if (a.type === "file") {
          const truncate = (flags & O_TRUNC) !== 0;
          const read = (flags & O_ACCMODE) !== 1,
            append = (flags & O_APPEND) !== 0;
          const file = await this.#open(
            f,
            state,
            fs.open(f.path, { read, write, truncate, append }),
            write,
          );
          a = (await file.getattr?.()) ?? (await fs.getattr(f.path));
          if (f.identity && !matchesIdentity(a, f.identity)) {
            this.#closeFile(f);
            throw new FsError("ESTALE", f.path);
          }
        }
        f.dir = undefined;
        return new Writer(HDR + 17).qid(qidOf(f.path, a)).u32(0);
      }
      case Tlcreate: {
        const f = this.#dir(r.u32());
        const name = r.name();
        const flags = r.u32(),
          mode = r.u32();
        checkName(name);
        const path = join(f.path, name);
        let file: FsFile;
        let how = { read: true, write: true, append: false };
        try {
          file = await this.#open(f, state, this.#need("create")(path, mode & 0o7777), false);
        } catch (e) {
          // The guest sends Tlcreate for a name it believes missing; if it exists now (the host made
          // it meanwhile), open(O_CREAT) without O_EXCL opens it, as on a local file system.
          if (flags & O_EXCL || (e as { code?: unknown } | null)?.code !== "EEXIST") throw e;
          const a = await fs.getattr(path);
          if (a.type !== "file") throw new FsError(a.type === "dir" ? "EISDIR" : "EEXIST");
          how = { read: (flags & O_ACCMODE) !== 1, write: true, append: (flags & O_APPEND) !== 0 };
          file = await this.#open(
            f,
            state,
            fs.open(path, { ...how, truncate: (flags & O_TRUNC) !== 0 }),
            true,
          );
        }
        const a = (await file.getattr?.()) ?? (await fs.getattr(path));
        if (!state.dead) {
          f.path = path;
          f.type = "file";
          f.identity = identityOf(a);
        }
        return new Writer(HDR + 17).qid(qidOf(path, a)).u32(0);
      }
      case Tmkdir:
      case Tsymlink: {
        const f = this.#dir(r.u32());
        const name = r.name();
        checkName(name);
        const path = join(f.path, name);
        if (type === Tmkdir) await this.#need("mkdir")(path, r.u32() & 0o7777);
        else await this.#need("symlink", "EOPNOTSUPP")(path, r.name());
        return new Writer(HDR + 13).qid(qidOf(path, await fs.getattr(path)));
      }
      case Tlink: {
        const directory = this.#dir(r.u32());
        const source = this.#fid(r.u32());
        const name = r.name();
        checkName(name);
        if (source.type === "dir") throw new FsError("EPERM", "directory hard link");
        if (!source.identity)
          throw new FsError("EOPNOTSUPP", "source has no stable inode identity");
        if (!directory.identity)
          throw new FsError("ESTALE", "directory has no saved inode identity");
        await this.#need("link", "EOPNOTSUPP")(source.path, join(directory.path, name), {
          source: source.identity,
          directory: directory.identity,
        });
        return new Writer(HDR);
      }
      case Tmknod:
        throw new FsError("EOPNOTSUPP");
      case Tunlinkat: {
        const f = this.#dir(r.u32());
        const name = r.name();
        const flags = r.u32();
        checkName(name);
        await this.#need("remove")(join(f.path, name), !!(flags & AT_REMOVEDIR));
        return new Writer(HDR);
      }
      case Trenameat:
      case Trename: {
        let from: string, to: string;
        if (type === Trenameat) {
          const od = this.#dir(r.u32()),
            oname = r.name(),
            nd = this.#dir(r.u32()),
            nname = r.name();
          checkName(oname);
          checkName(nname);
          from = join(od.path, oname);
          to = join(nd.path, nname);
        } else {
          const f = this.#fid(r.u32()),
            d = this.#dir(r.u32()),
            name = r.name();
          checkName(name);
          from = f.path;
          to = join(d.path, name);
        }
        if (from === "/" || (under(to, from) && to !== from))
          throw new FsError(from === "/" ? "EBUSY" : "EINVAL");
        if (from !== to) {
          const moved = await this.#need("rename")(from, to);
          if (moved !== false) this.#renamed(from, to);
        }
        return new Writer(HDR);
      }
      case Treadlink: {
        const f = this.#fid(r.u32());
        return new Writer().str(await this.#need("readlink", "EINVAL")(f.path));
      }
      case Tgetattr: {
        const f = this.#fid(r.u32());
        const file = fileOf(f);
        const a = file?.getattr ? await file.getattr() : await fs.getattr(f.path);
        const size = a.size ?? 0;
        const perm = a.mode ?? (a.type === "dir" ? 0o755 : a.type === "symlink" ? 0o777 : 0o644);
        const fmt = a.type === "dir" ? S_IFDIR : a.type === "symlink" ? S_IFLNK : S_IFREG;
        const w = new Writer(HDR + 153)
          .u64(P9_STATS_BASIC)
          .qid(qidOf(f.path, a))
          .u32(fmt | (perm & 0o7777))
          .u32(a.uid ?? FS_DEFAULT_OWNER)
          .u32(a.gid ?? FS_DEFAULT_OWNER)
          .u64(a.nlink ?? (a.type === "dir" ? 2 : 1))
          .u64(0)
          .u64(size)
          .u64(4096)
          .u64(Math.ceil(size / 512));
        const m = a.mtime ?? fsTimeNow();
        for (const t of [a.atime ?? m, m, a.ctime ?? m, fsTime(0n, 0)]) {
          const exact = fsTime(t.seconds, t.nanoseconds);
          w.u64(exact.seconds).u64(exact.nanoseconds);
        }
        return w.u64(0).u64(0);
      }
      case Tsetattr: {
        const f = this.#fid(r.u32());
        const valid = r.u32(),
          mode = r.u32(),
          uid = r.u32(),
          gid = r.u32(),
          size = r.u64();
        const as = r.u64(),
          an = r.u64(),
          ms = r.u64(),
          mn = r.u64();
        const attr: FsSetAttr = {};
        if (valid & 1) attr.mode = mode & 0o7777;
        if (valid & 2) attr.uid = uid;
        if (valid & 4) attr.gid = gid;
        if (valid & 8) attr.size = filePosition(size);
        const now = fsTimeNow();
        if (valid & 16) attr.atime = valid & 128 ? explicitTime(as, an) : now;
        if (valid & 32) attr.mtime = valid & 256 ? explicitTime(ms, mn) : now;
        // Omitted fields carry arbitrary bytes on the wire. No selected
        // attributes (and no ctime request) means no backend mutation at all.
        if (Object.keys(attr).length === 0 && !(valid & 64)) return new Writer(HDR);
        const file = fileOf(f);
        await this.#ordered(f, () =>
          file?.setattr ? file.setattr(attr) : this.#need("setattr")(f.path, attr),
        );
        return new Writer(HDR);
      }
      case Treaddir: {
        const f = this.#fid(r.u32());
        const offset = filePosition(r.u64()),
          count = r.u32();
        if (f.type !== "dir") throw new FsError("ENOTDIR");
        if (offset === 0 || !f.dir)
          f.dir = [
            { name: ".", type: "dir" },
            { name: "..", type: "dir" },
            ...(await fs.readdir(f.path)),
          ];
        const max = Math.min(count, this.#msize - HDR - 4);
        const w = new Writer(Math.min(max, 65536) + HDR + 4);
        w.u32(0);
        const start = w.n;
        for (let i = offset; i < f.dir.length; i++) {
          const e = f.dir[i]!;
          const name = enc.encode(e.name);
          if (w.n - start + 24 + name.length > max) break;
          const path =
            e.name === "." ? f.path : e.name === ".." ? parent(f.path) : join(f.path, e.name);
          w.u8(qidType(e.type))
            .u32(0)
            .u64(inode(path, e.ino, e.dev));
          w.u64(i + 1).u8(e.type === "dir" ? DT_DIR : e.type === "symlink" ? DT_LNK : DT_REG);
          w.u16(name.length).bytes(name);
        }
        w.dv.setUint32(HDR, w.n - start, true);
        return w;
      }
      case Tread: {
        const f = this.#fid(r.u32());
        const offset = filePosition(r.u64()),
          count = Math.min(r.u32(), this.#msize - HDR - 4);
        const file = fileOf(f);
        if (!file) throw new FsError(f.type === "dir" ? "EISDIR" : "EBADF");
        const data = await file.read(offset, count);
        const n = Math.min(data.length, count);
        // The reply buffer is the one copy of the data on this side.
        return new Writer(HDR + 4 + n).u32(n).bytes(n === data.length ? data : data.subarray(0, n));
      }
      case Twrite: {
        const f = this.#fid(r.u32());
        const offset = filePosition(r.u64()),
          count = r.u32();
        const data = r.bytes(count);
        const file = fileOf(f);
        if (!file?.write) throw new FsError(f.type === "dir" ? "EISDIR" : "EBADF");
        this.exp.stats.bytesWritten += count;
        return new Writer(HDR + 4).u32(await this.#ordered(f, () => file.write!(offset, data)));
      }
      case Tfsync: {
        // A directory, or a file without fsync: nothing to do on this side.
        const f = this.#fid(r.u32());
        const file = fileOf(f);
        await this.#ordered(f, () => file?.fsync?.());
        return new Writer(HDR);
      }
      case Tlock:
        // Locks are the guest's own: its kernel checks conflicts before asking.
        this.#fid(r.u32());
        return new Writer(HDR + 1).u8(0);
      case Tgetlock: {
        this.#fid(r.u32());
        r.u8();
        const start = r.u64(),
          length = r.u64(),
          procId = r.u32(),
          client = r.str();
        return new Writer().u8(2).u64(start).u64(length).u32(procId).str(client);
      }
      case Txattrwalk:
      case Txattrcreate:
        // Extended attributes are not implemented by these backends.
        throw new FsError("EOPNOTSUPP");
      default:
        throw new FsError("EOPNOTSUPP", `unknown message type ${type}`);
    }
  }
}
