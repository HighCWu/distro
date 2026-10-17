// SPDX-License-Identifier: MIT

import {
  type FS,
  type FSAttributes,
  type FSCreateContext,
  type FSDirectoryEntry,
  FSError,
  type FSSetAttributes,
  type FSTimestamp,
} from "@lowland/kernel";

const FileType = {
  directory: 0o040000,
  file: 0o100000,
} as const;

const OpenFlags = {
  EXCLUSIVE: 0x80,
  TRUNCATE: 0x200,
  APPEND: 0x400,
} as const;

interface Metadata {
  mode: number;
  uid: number;
  gid: number;
  atime: FSTimestamp;
  mtime: FSTimestamp;
  mtimeOverride: boolean;
  ctime: FSTimestamp;
}

function now(): FSTimestamp {
  const milliseconds = Date.now();
  return {
    seconds: BigInt(Math.floor(milliseconds / 1000)),
    nanoseconds: (milliseconds % 1000) * 1_000_000,
  };
}

function valid_name(name: string) {
  if (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\0")
  ) {
    throw new FSError("EINVAL", "invalid path component");
  }
  return name;
}

function opfs_error(error: unknown): never {
  if (error instanceof FSError) throw error;
  const name = error instanceof DOMException ? error.name : "";
  const code =
    {
      InvalidModificationError: "ENOTEMPTY",
      NoModificationAllowedError: "EACCES",
      NotAllowedError: "EACCES",
      NotFoundError: "ENOENT",
      QuotaExceededError: "ENOSPC",
      TypeMismatchError: "EINVAL",
    }[name] ?? "EIO";
  throw new FSError(
    code as ConstructorParameters<typeof FSError>[0],
    error instanceof Error ? error.message : String(error),
  );
}

async function opfs_call<T>(operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    opfs_error(error);
  }
}

function checked_offset(value: bigint) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new FSError("EINVAL", "offset exceeds JavaScript's integer range");
  }
  return result;
}

function checked_range(offset: bigint, length: number) {
  const start = checked_offset(offset);
  if (!Number.isSafeInteger(length) || length < 0 || length > Number.MAX_SAFE_INTEGER - start) {
    throw new FSError("EINVAL", "I/O range exceeds JavaScript's integer range");
  }
  return { start, end: start + length };
}

function checked_timestamp(timestamp: FSTimestamp): FSTimestamp {
  const nanoseconds = timestamp.nanoseconds ?? 0;
  if (!Number.isInteger(nanoseconds) || nanoseconds < 0 || nanoseconds >= 1_000_000_000) {
    throw new FSError("EINVAL", "invalid timestamp nanoseconds");
  }
  // Keep bigint seconds intact, including negative and wide timestamps.
  return { seconds: timestamp.seconds, nanoseconds };
}

async function commit_opfs_write(
  writable: FileSystemWritableFileStream,
  operation: () => Promise<unknown>,
) {
  try {
    await operation();
    await opfs_call(writable.close());
  } catch (error) {
    // Closing commits the temporary file. Failed operations must abort it,
    // and an abort failure must not hide the original storage error.
    try {
      await writable.abort(error);
    } catch {}
    throw error;
  }
}

class Node {
  parts: string[];
  handle: FileSystemHandle;
  metadata: Metadata;
  mutation = Promise.resolve();
  location = 0;
  // Browser handles identify a locator rather than an inode generation and may
  // resolve a same-path recreation. Once removal is observed, permanently
  // detach this generation so old guest handles fail instead of retargeting it.
  attached = true;

  constructor(parts: string[], handle: FileSystemHandle, metadata: Metadata) {
    this.parts = parts;
    this.handle = handle;
    this.metadata = metadata;
  }
}

class Handle {
  readonly node: Node;
  readonly append: boolean;

  constructor(node: Node, append = false) {
    this.node = node;
    this.append = append;
  }
}

function default_metadata(kind: FileSystemHandle["kind"]): Metadata {
  const timestamp = now();
  return {
    mode: FileType[kind] | (kind === "directory" ? 0o755 : 0o644),
    uid: 0,
    gid: 0,
    atime: timestamp,
    mtime: timestamp,
    mtimeOverride: false,
    ctime: timestamp,
  };
}

/**
 * A virtio-fs backend for a browser `FileSystemDirectoryHandle`.
 *
 * The browser File System API exposes no Unix ownership, permissions, links,
 * or inode metadata. This adapter presents conventional synthetic values for
 * them and keeps chmod/chown/timestamp changes for the lifetime of this object.
 *
 * Rename copies to the destination and then removes the source because the
 * portable API has no atomic namespace rename. Replacing a destination first
 * removes it, as required by package managers and other normal Linux software.
 * Failure can therefore lose the old destination, leave a partial new one, or
 * leave both names if removing the source fails.
 *
 * Browser handles cannot keep an unlinked file alive like a POSIX descriptor.
 * When this adapter observes removal, existing descriptors become stale and
 * fail rather than targeting a new entry created at the same path. An external
 * remove-and-recreate with no observed missing state cannot be distinguished.
 * Writes and truncations through one adapter are serialized per node, but
 * other adapters or applications can still race its portable API operations.
 */
export class BrowserFS implements FS<Node, Handle> {
  readonly root: Node;
  readonly #nodes = new Map<string, Node>();
  readonly #ownedNodes = new WeakSet<Node>();
  // Portable handles have no exclusive create/namespace transaction. Keep
  // this adapter's check-and-mutate sequences from interleaving with each other.
  readonly #namespace = { mutation: Promise.resolve() };
  #directoryMove?: { parts: string[]; destination: string[]; done: PromiseWithResolvers<void> };
  #directoryLocation = 0;

  constructor(root: FileSystemDirectoryHandle) {
    this.root = new Node([], root, default_metadata("directory"));
    this.#ownedNodes.add(this.root);
    this.#nodes.set("", this.root);
  }

  #as_node(node: Node) {
    if (!(node instanceof Node) || !this.#ownedNodes.has(node)) {
      throw new FSError("EINVAL", "node belongs to another filesystem");
    }
    if (!node.attached) {
      throw new FSError("ENOENT", "filesystem node is no longer attached");
    }
    return node;
  }

  #directory(node: Node) {
    const result = this.#as_node(node);
    if (result.handle.kind !== "directory") {
      throw new FSError("ENOTDIR");
    }
    return result.handle as FileSystemDirectoryHandle;
  }

  #remember(parts: string[], handle: FileSystemHandle) {
    const key = parts.join("/");
    let node = this.#nodes.get(key);
    if (!node) {
      node = new Node(parts, handle, default_metadata(handle.kind));
      this.#ownedNodes.add(node);
      this.#nodes.set(key, node);
    } else {
      node.handle = handle;
    }
    return node;
  }

  #forget(parts: readonly string[]) {
    const key = parts.join("/");
    for (const [candidate, node] of this.#nodes) {
      if (candidate === key || candidate.startsWith(`${key}/`)) {
        node.attached = false;
        this.#nodes.delete(candidate);
      }
    }
  }

  #open_handle(node: Node, handle: Handle) {
    const current = this.#as_node(node);
    if (!(handle instanceof Handle) || handle.node !== current) {
      throw new FSError("EBADF");
    }
    return current;
  }

  #directory_blocker(node: Node) {
    return this.#path_blocker(node.parts);
  }

  #path_blocker(parts: readonly string[], ancestors = false) {
    const move = this.#directoryMove;
    return move &&
      [move.parts, move.destination].some(
        (prefix) =>
          prefix.every((part, index) => parts[index] === part) ||
          (ancestors && parts.every((part, index) => prefix[index] === part)),
      )
      ? move
      : undefined;
  }

  async #mutate<T>(
    node: Pick<Node, "mutation">,
    operation: () => Promise<T>,
    relocationOwner = false,
  ): Promise<T> {
    // Directory relocation drains pre-existing mutations. Later subtree
    // mutations must wait outside their node queue, otherwise relocation would
    // wait for work that in turn waits for relocation itself.
    if (node instanceof Node && !relocationOwner) {
      for (let blocker; (blocker = this.#directory_blocker(node));) await blocker.done.promise;
    }
    const previous = node.mutation;
    const completion = Promise.withResolvers<void>();
    node.mutation = completion.promise;
    await previous;
    try {
      return await operation();
    } finally {
      completion.resolve();
    }
  }

  async #child(
    parent: FileSystemDirectoryHandle,
    name: string,
  ): Promise<FileSystemHandle | undefined> {
    try {
      return await parent.getDirectoryHandle(name);
    } catch (error) {
      if (
        !(error instanceof DOMException) ||
        !["NotFoundError", "TypeMismatchError"].includes(error.name)
      ) {
        opfs_error(error);
      }
    }
    try {
      return await parent.getFileHandle(name);
    } catch (error) {
      if (
        error instanceof DOMException &&
        ["NotFoundError", "TypeMismatchError"].includes(error.name)
      ) {
        return undefined;
      }
      opfs_error(error);
    }
  }

  async lookup(parent: Node, name: string) {
    name = valid_name(name);
    for (;;) {
      const current = this.#as_node(parent);
      const parts = [...current.parts, name];
      const blocker = this.#path_blocker(parts);
      if (blocker) {
        await blocker.done.promise;
        continue;
      }
      const location = current.location;
      const directoryLocation = this.#directoryLocation;
      const handle = await this.#child(this.#directory(current), name);
      // A lookup that was already in flight when relocation started must not
      // publish a stale locator or detach the newly moved generation.
      this.#as_node(current);
      if (
        this.#path_blocker(parts) ||
        current.location !== location ||
        this.#directoryLocation !== directoryLocation
      )
        continue;
      if (!handle) {
        this.#forget(parts);
        return undefined;
      }
      return this.#remember(parts, handle);
    }
  }

  async getattr(node: Node): Promise<FSAttributes> {
    const current = this.#as_node(node);
    let size = 0n;
    if (current.handle.kind === "file") {
      const file = await opfs_call((current.handle as FileSystemFileHandle).getFile());
      size = BigInt(file.size);
      if (!current.metadata.mtimeOverride) {
        current.metadata.mtime = {
          seconds: BigInt(Math.floor(file.lastModified / 1000)),
          nanoseconds: (file.lastModified % 1000) * 1_000_000,
        };
      }
    }
    return {
      mode: current.metadata.mode,
      size,
      nlink: current.handle.kind === "directory" ? 2 : 1,
      uid: current.metadata.uid,
      gid: current.metadata.gid,
      blockSize: 4096,
      atime: current.metadata.atime,
      mtime: current.metadata.mtime,
      ctime: current.metadata.ctime,
    };
  }

  async setattr(node: Node, changes: FSSetAttributes) {
    const current = this.#as_node(node);
    // Validate every timestamp before truncating or changing any metadata.
    // Snapshot explicit values so later caller changes cannot mutate metadata.
    const atime =
      changes.atime === undefined || changes.atime === "now"
        ? changes.atime
        : checked_timestamp(changes.atime);
    const mtime =
      changes.mtime === undefined || changes.mtime === "now"
        ? changes.mtime
        : checked_timestamp(changes.mtime);
    const ctime = changes.ctime === undefined ? undefined : checked_timestamp(changes.ctime);
    return await this.#mutate(current, async () => {
      this.#as_node(current);
      if (changes.size !== undefined) {
        const size = checked_offset(changes.size);
        if (current.handle.kind !== "file") {
          throw new FSError("EISDIR");
        }
        const writable = await opfs_call(
          (current.handle as FileSystemFileHandle).createWritable({
            keepExistingData: true,
          }),
        );
        await commit_opfs_write(writable, async () => {
          await opfs_call(writable.truncate(size));
        });
        // Truncation changes the backing file, so its native timestamp becomes
        // authoritative unless this setattr also supplies an explicit mtime.
        current.metadata.mtimeOverride = false;
      }
      if (changes.mode !== undefined) {
        current.metadata.mode = (current.metadata.mode & 0o170000) | (changes.mode & 0o7777);
      }
      if (changes.uid !== undefined) current.metadata.uid = changes.uid;
      if (changes.gid !== undefined) current.metadata.gid = changes.gid;
      if (atime !== undefined) {
        current.metadata.atime = atime === "now" ? now() : atime;
      }
      if (mtime !== undefined) {
        current.metadata.mtime = mtime === "now" ? now() : mtime;
        current.metadata.mtimeOverride = true;
      }
      if (ctime !== undefined) current.metadata.ctime = ctime;
      else current.metadata.ctime = now();
      return await this.getattr(current);
    });
  }

  async open(node: Node, flags: number) {
    const current = this.#as_node(node);
    if (current.handle.kind !== "file") {
      throw new FSError("EISDIR");
    }
    if (flags & OpenFlags.TRUNCATE) {
      await this.setattr(current, { size: 0n });
    }
    return new Handle(current, Boolean(flags & OpenFlags.APPEND));
  }

  async create(parent: Node, name: string, flags: number, context: FSCreateContext) {
    return await this.#mutate(this.#namespace, () => this.#create(parent, name, flags, context));
  }

  async #create(parent: Node, name: string, flags: number, context: FSCreateContext) {
    name = valid_name(name);
    const parent_node = this.#as_node(parent);
    const directory = this.#directory(parent);
    const existing = await this.#child(directory, name);
    if (existing) {
      if (flags & OpenFlags.EXCLUSIVE) {
        throw new FSError("EEXIST");
      }
      if (existing.kind !== "file") {
        throw new FSError("EISDIR");
      }
    }
    const file = existing ?? (await opfs_call(directory.getFileHandle(name, { create: true })));
    const node = this.#remember([...parent_node.parts, name], file);
    if (!existing) {
      node.metadata.mode = FileType.file | (context.mode & 0o7777);
      node.metadata.uid = context.uid;
      node.metadata.gid = context.gid;
    }
    if (flags & OpenFlags.TRUNCATE) await this.setattr(node, { size: 0n });
    return { node, handle: new Handle(node, Boolean(flags & OpenFlags.APPEND)) };
  }

  async read(node: Node, handle: Handle, offset: bigint, length: number) {
    const current = this.#open_handle(node, handle);
    const { start, end } = checked_range(offset, length);
    if (current.handle.kind !== "file") {
      throw new FSError("EISDIR");
    }
    const file = await opfs_call((current.handle as FileSystemFileHandle).getFile());
    current.metadata.atime = now();
    return new Uint8Array(await opfs_call(file.slice(start, end).arrayBuffer()));
  }

  async write(node: Node, handle: Handle, offset: bigint, data: Uint8Array, flags?: number) {
    const current = this.#open_handle(node, handle);
    const range = checked_range(offset, data.byteLength);
    const append = flags === undefined ? handle.append : Boolean(flags & OpenFlags.APPEND);
    return await this.#mutate(current, async () => {
      this.#open_handle(node, handle);
      if (current.handle.kind !== "file") {
        throw new FSError("EISDIR");
      }
      // Resolve EOF inside the mutation queue, after earlier writes commit.
      // Portable OPFS has no atomic append across independent adapters.
      const start = append
        ? checked_range(
            BigInt((await opfs_call((current.handle as FileSystemFileHandle).getFile())).size),
            data.byteLength,
          ).start
        : range.start;
      const writable = await opfs_call(
        (current.handle as FileSystemFileHandle).createWritable({
          keepExistingData: true,
        }),
      );
      await commit_opfs_write(writable, async () => {
        await opfs_call(writable.seek(start));
        const copy = new Uint8Array(data.byteLength);
        copy.set(data);
        await opfs_call(writable.write(copy.buffer));
      });
      current.metadata.mtime = now();
      current.metadata.mtimeOverride = false;
      current.metadata.ctime = current.metadata.mtime;
      return data.byteLength;
    });
  }

  // Writes commit when their streams close. Join the per-node mutation queue
  // so concurrent requests cannot acknowledge synchronization before that
  // commit. The portable API exposes no additional physical-media flush.
  async flush(node: Node, handle: Handle) {
    const current = this.#open_handle(node, handle);
    await this.#mutate(current, async () => {
      this.#open_handle(node, handle);
    });
  }

  async fsync(node: Node, handle: Handle, _dataOnly: boolean) {
    await this.flush(node, handle);
  }

  async opendir(node: Node) {
    this.#directory(node);
    return new Handle(this.#as_node(node));
  }

  async readdir(node: Node, handle: Handle): Promise<FSDirectoryEntry<Node>[]> {
    for (;;) {
      const current = this.#open_handle(node, handle);
      const blocker = this.#path_blocker(current.parts, true);
      if (blocker) {
        await blocker.done.promise;
        continue;
      }
      const location = current.location;
      const directoryLocation = this.#directoryLocation;
      const entries: [string, FileSystemHandle][] = [];
      try {
        for await (const entry of this.#directory(current).entries()) entries.push(entry);
      } catch (error) {
        if (
          this.#path_blocker(current.parts, true) ||
          this.#directoryLocation !== directoryLocation
        )
          continue;
        opfs_error(error);
      }
      this.#open_handle(node, handle);
      if (
        this.#path_blocker(current.parts, true) ||
        current.location !== location ||
        this.#directoryLocation !== directoryLocation
      )
        continue;
      return entries.map(([name, handle]) => ({
        name,
        node: this.#remember([...current.parts, name], handle),
        type: handle.kind,
      }));
    }
  }

  async mkdir(parent: Node, name: string, context: FSCreateContext) {
    return await this.#mutate(this.#namespace, () => this.#mkdir(parent, name, context));
  }

  async #mkdir(parent: Node, name: string, context: FSCreateContext) {
    name = valid_name(name);
    const parent_node = this.#as_node(parent);
    if (await this.#child(this.#directory(parent), name)) {
      throw new FSError("EEXIST");
    }
    const handle = await opfs_call(
      this.#directory(parent).getDirectoryHandle(name, { create: true }),
    );
    const node = this.#remember([...parent_node.parts, name], handle);
    node.metadata.mode = FileType.directory | (context.mode & 0o7777);
    node.metadata.uid = context.uid;
    node.metadata.gid = context.gid;
    return node;
  }

  async unlink(parent: Node, name: string) {
    return await this.#mutate(this.#namespace, () => this.#unlink(parent, name));
  }

  async #unlink(parent: Node, name: string) {
    name = valid_name(name);
    const child = await this.lookup(parent, name);
    if (!child) throw new FSError("ENOENT");
    if (this.#as_node(child).handle.kind !== "file") {
      throw new FSError("EISDIR");
    }
    // Own writable streams must finish committing or aborting before removal.
    // Reserve the node queue through detachment so later queued writes cannot
    // reopen a same-path replacement after this namespace operation succeeds.
    await this.#mutate(child, async () => {
      this.#as_node(child);
      await opfs_call(this.#directory(parent).removeEntry(name));
      this.#forget([...this.#as_node(parent).parts, name]);
    });
  }

  async rmdir(parent: Node, name: string) {
    return await this.#mutate(this.#namespace, () => this.#rmdir(parent, name));
  }

  async #rmdir(parent: Node, name: string) {
    name = valid_name(name);
    const child = await this.lookup(parent, name);
    if (!child) throw new FSError("ENOENT");
    if (this.#as_node(child).handle.kind !== "directory") {
      throw new FSError("ENOTDIR");
    }
    await opfs_call(this.#directory(parent).removeEntry(name));
    this.#forget([...this.#as_node(parent).parts, name]);
  }

  async #copy(source: FileSystemHandle, destination: FileSystemDirectoryHandle, name: string) {
    // Portable File System handles provide no atomic recursive rename or
    // namespace transaction. Copy only into an absent destination and never
    // delete unrelated destination data. A failed copy may still leave the
    // partial destination created by this operation.
    if (source.kind === "file") {
      const input = await opfs_call((source as FileSystemFileHandle).getFile());
      const output = await opfs_call(destination.getFileHandle(name, { create: true }));
      const writable = await opfs_call(output.createWritable());
      // pipeTo closes the destination after success and aborts it if reading
      // the source fails, without materializing the complete file in memory.
      await opfs_call(input.stream().pipeTo(writable));
      return output;
    }
    const output = await opfs_call(destination.getDirectoryHandle(name, { create: true }));
    for await (const [child_name, child] of (source as FileSystemDirectoryHandle).entries()) {
      await this.#copy(child, output, child_name);
    }
    return output;
  }

  async rename(oldParent: Node, oldName: string, newParent: Node, newName: string) {
    return await this.#mutate(this.#namespace, () =>
      this.#rename(oldParent, oldName, newParent, newName),
    );
  }

  async #rename(oldParent: Node, oldName: string, newParent: Node, newName: string) {
    oldName = valid_name(oldName);
    newName = valid_name(newName);
    const old_parent = this.#as_node(oldParent);
    const new_parent = this.#as_node(newParent);
    const source = await this.lookup(old_parent, oldName);
    if (!source) throw new FSError("ENOENT");
    if (old_parent === new_parent && oldName === newName) return;
    const source_node = this.#as_node(source);
    const existing = await this.lookup(new_parent, newName);
    const move = () =>
      this.#move_node(old_parent, oldName, new_parent, newName, source_node, existing);
    // Copying a file snapshots its committed bytes. Keep the source's mutation
    // queue reserved until its handle has been retargeted to the new name.
    if (source_node.handle.kind === "file") await this.#mutate(source_node, move);
    else {
      // The namespace queue permits only one relocation. Install the barrier
      // synchronously before capturing pending work so newly discovered nodes
      // cannot start writes outside this snapshot.
      const barrier = {
        parts: [...source_node.parts],
        destination: [...new_parent.parts, newName],
        done: Promise.withResolvers<void>(),
      };
      this.#directoryMove = barrier;
      this.#directoryLocation++;
      const pending = [...this.#nodes.values()]
        .filter((node) => this.#directory_blocker(node) === barrier)
        .map((node) => node.mutation);
      try {
        await Promise.all(pending);
        await move();
      } finally {
        this.#directoryMove = undefined;
        this.#directoryLocation++;
        barrier.done.resolve();
      }
    }
  }

  async #move_node(
    old_parent: Node,
    oldName: string,
    new_parent: Node,
    newName: string,
    source_node: Node,
    existing: Node | undefined,
  ) {
    this.#as_node(source_node);
    const old_parts = [...old_parent.parts, oldName];
    if (this.#nodes.get(old_parts.join("/")) !== source_node) throw new FSError("ENOENT");
    const new_parts = [...new_parent.parts, newName];
    if (
      source_node.handle.kind === "directory" &&
      new_parts.slice(0, old_parts.length).join("/") === old_parts.join("/")
    ) {
      throw new FSError("EINVAL", "cannot move a directory into itself");
    }

    if (existing) {
      const existing_node = this.#as_node(existing);
      if (source_node.handle.kind === "directory" && existing_node.handle.kind !== "directory") {
        throw new FSError("ENOTDIR");
      }
      if (source_node.handle.kind === "file" && existing_node.handle.kind !== "file") {
        throw new FSError("EISDIR");
      }
      // Linux applications routinely publish updates by renaming a temporary
      // file over its destination. The portable browser API cannot make that
      // replacement atomic, but rejecting it prevents package installation and
      // similarly fundamental workflows. Keep the source until its replacement
      // has been copied so a failed operation still retains the new data.
      // Like unlink, replacement must wait for this adapter's outstanding
      // destination writes/truncations to commit or abort. Keep the queue
      // reserved until the old generation is detached; later old-handle writes
      // then fail rather than touching the copied source at the same name.
      await this.#mutate(
        existing_node,
        async () => {
          this.#as_node(existing_node);
          await opfs_call(
            this.#directory(new_parent).removeEntry(newName, {
              recursive: false,
            }),
          );
          this.#forget(new_parts);
        },
        true,
      ); // This namespace operation may pass through its own relocation barrier.
    }

    const destination = this.#directory(new_parent);
    const cleanup_destination = () =>
      destination
        .removeEntry(newName, {
          recursive: source_node.handle.kind === "directory",
        })
        .catch(() => {});
    let copied: FileSystemHandle;
    try {
      copied = await this.#copy(source_node.handle, destination, newName);
    } catch (error) {
      await cleanup_destination();
      throw error;
    }
    try {
      await opfs_call(
        this.#directory(old_parent).removeEntry(oldName, {
          recursive: source_node.handle.kind === "directory",
        }),
      );
    } catch (error) {
      await cleanup_destination();
      throw error;
    }

    const moved = [...this.#nodes].filter(
      ([key]) => key === old_parts.join("/") || key.startsWith(`${old_parts.join("/")}/`),
    );
    moved.sort(([, left], [, right]) => left.parts.length - right.parts.length);
    for (const [key, node] of moved) {
      const relative = node.parts.slice(old_parts.length);
      let handle: FileSystemHandle = copied;
      for (const component of relative) {
        if (handle.kind !== "directory") throw new FSError("EIO");
        const child = await this.#child(handle as FileSystemDirectoryHandle, component);
        if (!child) throw new FSError("EIO");
        handle = child;
      }
      node.handle = handle;
      node.location++;
      if (key === old_parts.join("/") || key.startsWith(`${old_parts.join("/")}/`)) {
        this.#nodes.delete(key);
        node.parts = [...new_parts, ...node.parts.slice(old_parts.length)];
        this.#nodes.set(node.parts.join("/"), node);
      }
    }
  }
}
