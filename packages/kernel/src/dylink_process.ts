// SPDX-License-Identifier: MIT
import {
  DylinkInitializationError,
  link_dylink_graph,
  type DylinkExternalSymbol,
} from "./dylink_linker.ts";
import { plan_dylink_layout } from "./dylink.ts";
import {
  read_wasm_dylink,
  read_wasm_dynamic_imports,
  type WasmDylink,
  type WasmTableType,
} from "./wasm_binary.ts";
import {
  memory_bytes,
  wasm_pointer_to_number,
  wasm_size_to_number,
  wasm_table_get,
  type WasmAddress,
  type WasmAddressType,
} from "./wasm.ts";

type Group = ReturnType<typeof link_dylink_graph>;
type File = {
  pin: number;
  key: string;
  path: string;
  bytes: Uint8Array<ArrayBuffer>;
  module: WebAssembly.Module;
  metadata: WasmDylink;
  dependencies: Map<string, string>;
};
type Options = {
  main: WebAssembly.Instance;
  memory: WebAssembly.Memory;
  address: WasmAddressType;
  maximumPages: number;
  tableType: WasmTableType;
  signatures: ReadonlyMap<string, string>;
  isControlFlow(error: unknown): boolean;
  fatal(error: unknown): never;
  pinFile(fd: number, device: bigint, inode: bigint): number;
  unpinFile(id: number): number;
};

// Only failures to open a path may advance to a later search directory.
// An opened object's admission, read or format failure must retain precedence.
class DylinkSearchMiss extends Error {}

/** Per-main-instance execution state. Files come exclusively through the main
 * program's guarded Linux syscalls. Modules remain resident as musl dlclose does;
 * this profile has no Worker publication or fork snapshot protocol yet. */
export class ProcessDylink {
  readonly #options: Options;
  readonly #table: WebAssembly.Table;
  readonly #stack: WebAssembly.Global;
  readonly #symbols = new Map<string, DylinkExternalSymbol>();
  readonly #pointers = new Map<CallableFunction, bigint>();
  readonly #files = new Map<string, File>();
  readonly #aliases = new Map<string, string>();
  readonly #reuse = new Map<
    string,
    { instance: WebAssembly.Instance; base: bigint; tableBase: bigint }
  >();
  readonly #groups = new Map<string, { group: Group; handle: number }>();
  readonly #handles = new Map<number, Group>();
  #cursor: bigint;
  #busy = false;
  #error = "Dynamic loader failure";

  constructor(options: Options) {
    this.#options = options;
    const table = options.main.exports.__indirect_function_table;
    const stack = options.main.exports.__stack_pointer;
    if (
      !(table instanceof WebAssembly.Table) ||
      !(stack instanceof WebAssembly.Global) ||
      this.#call("__wasm_dlopen_io_v1") !== 1
    )
      throw new Error("incompatible dynamic main execution support");
    this.#table = table;
    this.#stack = stack;
    this.#cursor = BigInt(table.length);
    for (let index = 3n; index < this.#cursor; index++) {
      const fn = wasm_table_get(table, this.#word(index, options.tableType.address));
      if (fn && !this.#pointers.has(fn)) this.#pointers.set(fn, index);
    }
    for (const [name, value] of Object.entries(options.main.exports)) {
      if (typeof value === "function")
        this.#symbols.set(name, {
          value,
          signature: options.signatures.get(name),
          address: this.#pointers.get(value),
        });
      else if (
        value instanceof WebAssembly.Global &&
        (typeof value.value === "number" || typeof value.value === "bigint")
      )
        this.#symbols.set(name, { value, address: this.#unsigned(value.value) });
    }
  }
  #word(value: bigint, address = this.#options.address): WasmAddress {
    return address === "i64" ? value : Number(value);
  }
  #unsigned(value: WasmAddress) {
    return BigInt.asUintN(this.#options.address === "i64" ? 64 : 32, BigInt(value));
  }
  #call(name: string, ...args: WasmAddress[]): WasmAddress {
    const fn = this.#options.main.exports[name];
    if (typeof fn !== "function") throw new Error(`missing private dynamic callback: ${name}`);
    try {
      return fn(...args) as WasmAddress;
    } catch (error) {
      if (this.#options.isControlFlow(error)) throw error;
      throw new DylinkInitializationError(error);
    }
  }
  #string(pointer: WasmAddress): string {
    const start = wasm_pointer_to_number(pointer);
    const buffer = this.#options.memory.buffer;
    if (start >= buffer.byteLength) throw new Error("invalid dynamic string pointer");
    const view = new Uint8Array(buffer, start, Math.min(4096, buffer.byteLength - start));
    const end = view.indexOf(0);
    if (end < 0) throw new Error("unterminated dynamic string");
    return new TextDecoder("utf-8", { fatal: true }).decode(view.subarray(0, end));
  }
  #failure(error: unknown): WasmAddress {
    if (this.#options.isControlFlow(error)) throw error;
    if (error instanceof DylinkInitializationError) this.#options.fatal(error);
    this.#error = error instanceof Error ? error.message : "Dynamic loader failure";
    return this.#word(0n);
  }
  #read(path: string, known: ReadonlyMap<string, File>): File {
    const encoded = new TextEncoder().encode(path + "\0");
    if (encoded.length > 4096) throw new DylinkSearchMiss("dynamic path exceeds PATH_MAX");
    const pointer = this.#call(
      "__wasm_dlopen_allocate",
      this.#word(BigInt(encoded.length)),
      this.#word(1n),
    );
    if (!this.#unsigned(pointer)) throw new Error("cannot allocate dynamic path");
    let control = false;
    try {
      const target = memory_bytes(this.#options.memory, pointer, encoded.length);
      if (!target) throw new Error("invalid dynamic path allocation");
      target.set(encoded);
      const descriptor = this.#call("__wasm_dlopen_read", pointer);
      const fields = memory_bytes(this.#options.memory, descriptor, 40);
      if (!fields) throw new Error("invalid dynamic file descriptor");
      const view = new DataView(fields.buffer, fields.byteOffset, fields.byteLength);
      const error = view.getBigUint64(32, true);
      let abandon = false;
      try {
        const key = `${view.getBigUint64(16, true)}:${view.getBigUint64(24, true)}`;
        const resident = known.get(key);
        // An existing inode is already code in this process. Later file content
        // changes or admission errors must not replace/reset the live object.
        if (error !== 16n && resident) return resident;
        if (error) {
          const message = `cannot open ${path}: errno ${error}`;
          if ([2n, 13n, 20n, 36n].includes(error) && Number(this.#call("__wasm_dlopen_fd")) < 0)
            throw new DylinkSearchMiss(message);
          throw new Error(message);
        }
        const size = view.getBigUint64(8, true);
        if (size > 64n * 1024n * 1024n) throw new Error("dynamic file exceeds profile capacity");
        const bytes = memory_bytes(
          this.#options.memory,
          this.#word(view.getBigUint64(0, true)),
          this.#word(size),
        );
        if (!bytes) throw new Error("invalid dynamic file data");
        const copy = new Uint8Array(bytes);
        const origin = this.#string(this.#call("__wasm_dlopen_origin"));
        const module = new WebAssembly.Module(copy);
        const metadata = read_wasm_dylink(module);
        if (!metadata) throw new Error("file is not a Wasm dynamic library");
        const pin = this.#options.pinFile(
          Number(this.#call("__wasm_dlopen_fd")),
          view.getBigUint64(16, true),
          view.getBigUint64(24, true),
        );
        if (pin <= 0) throw new Error(`cannot retain dynamic file identity: errno ${-pin}`);
        return {
          pin,
          key,
          path: origin,
          bytes: copy,
          module,
          metadata,
          dependencies: new Map(),
        };
      } catch (error) {
        abandon = this.#options.isControlFlow(error) || error instanceof DylinkInitializationError;
        throw error;
      } finally {
        // EBUSY describes someone else's outstanding buffer, never this read's.
        if (!abandon && error !== 16n) this.#call("__wasm_dlopen_read_release");
      }
    } catch (error) {
      control = this.#options.isControlFlow(error) || error instanceof DylinkInitializationError;
      throw error;
    } finally {
      if (!control) this.#call("__wasm_dlopen_deallocate", pointer);
    }
  }
  #grow(end: bigint) {
    if (end > BigInt(this.#table.length)) {
      const grow = this.#table.grow as unknown as (delta: WasmAddress) => WasmAddress;
      grow.call(
        this.#table,
        this.#word(end - BigInt(this.#table.length), this.#options.tableType.address),
      );
    }
  }
  #unpin(pointer: number) {
    if (this.#options.unpinFile(pointer) !== 0)
      throw new DylinkInitializationError(new Error("dynamic file reference cleanup failed"));
  }
  #address(symbol: DylinkExternalSymbol): bigint {
    if (symbol.address !== undefined) return symbol.address;
    if (typeof symbol.value !== "function") throw new Error("dynamic symbol has no address");
    let pointer = this.#pointers.get(symbol.value);
    if (pointer === undefined) {
      pointer = this.#cursor;
      this.#grow(pointer + 1n);
      const set = this.#table.set as unknown as (index: WasmAddress, fn: CallableFunction) => void;
      set.call(this.#table, this.#word(pointer, this.#options.tableType.address), symbol.value);
      this.#cursor++;
      this.#pointers.set(symbol.value, pointer);
    }
    symbol.address = pointer;
    return pointer;
  }
  #promote(group: Group) {
    const pending = group.names
      .filter((name) => !this.#symbols.has(name))
      .map((name) => [name, group.lookup(name)!] as const);
    for (const [name, symbol] of pending) this.#symbols.set(name, symbol);
  }
  open(pathPointer: WasmAddress, flags: number): WasmAddress {
    let allocation: WasmAddress | undefined;
    let acquired = false;
    let committed = false;
    const pins: number[] = [];
    try {
      if (flags & ~0x1107 || !(flags & 3)) throw new Error("invalid dlopen mode");
      if (!this.#unsigned(pathPointer)) return this.#word(1n);
      if (this.#busy) throw new Error("recursive dynamic loading is not supported yet");
      this.#busy = true;
      acquired = true;
      const path = this.#string(pathPointer);
      const local = new Map(this.#files);
      const aliases = new Map(this.#aliases);
      let environment: string[] | undefined;
      const searchEnvironment = () => {
        if (environment) return environment;
        const pointer = this.#call("__wasm_dlopen_library_path");
        return (environment = this.#unsigned(pointer) ? this.#string(pointer).split(":") : []);
      };
      let newBytes = 0;
      const find = (name: string, parent?: File): File => {
        const existing = aliases.get(name);
        if (existing && local.has(existing)) return local.get(existing)!;
        const origin = parent ? parent.path.slice(0, parent.path.lastIndexOf("/")) || "/" : ".";
        const runtimePaths =
          parent?.metadata.runtimePaths.flatMap((entry) => entry.split(":")) ?? [];
        const candidates = name.includes("/")
          ? [name]
          : [
              ...searchEnvironment(),
              ...runtimePaths.map((entry) => entry.replace(/\$\{ORIGIN\}|\$ORIGIN/g, origin)),
              "/lib",
              "/usr/lib",
            ].map((directory) => `${directory || "."}/${name}`);
        let failure: unknown = new Error(`dynamic library not found: ${name}`);
        for (const candidate of candidates) {
          const known = aliases.get(candidate);
          if (known && local.has(known)) return local.get(known)!;
          try {
            const file = this.#read(candidate, local);
            if (local.has(file.key)) {
              aliases.set(candidate, file.key);
              if (!aliases.has(name)) aliases.set(name, file.key);
              return local.get(file.key)!;
            }
            newBytes += file.bytes.length;
            if (newBytes > 64 * 1024 * 1024 || local.size >= 1024) {
              this.#unpin(file.pin);
              throw new Error("dynamic graph exceeds profile capacity");
            }
            pins.push(file.pin);
            local.set(file.key, file);
            aliases.set(candidate, file.key);
            if (!aliases.has(name)) aliases.set(name, file.key);
            const basename = file.path.slice(file.path.lastIndexOf("/") + 1);
            if (!aliases.has(basename)) aliases.set(basename, file.key);
            return file;
          } catch (error) {
            if (!(error instanceof DylinkSearchMiss)) throw error;
            failure = error;
          }
        }
        throw failure;
      };
      const root = find(path);
      const old = this.#groups.get(root.key);
      if (old) {
        if (flags & 256) this.#promote(old.group);
        for (const [name, key] of aliases) this.#aliases.set(name, key);
        return this.#word(BigInt(old.handle));
      }
      if (flags & 4 && !this.#reuse.has(root.key))
        throw new Error("library is not loaded (RTLD_NOLOAD)");
      const queue = [root];
      const visited = new Set<string>();
      for (let index = 0; index < queue.length; index++) {
        const file = queue[index]!;
        if (visited.has(file.key)) continue;
        visited.add(file.key);
        if (this.#reuse.has(file.key)) {
          for (const key of file.dependencies.values()) queue.push(local.get(key)!);
          continue;
        }
        for (const dependency of file.metadata.needed) {
          const child = find(dependency, file);
          file.dependencies.set(dependency, child.key);
          queue.push(child);
        }
      }
      const files = [...visited].map((key) => local.get(key)!);
      const fresh = files.filter((file) => !this.#reuse.has(file.key));
      let size = 1n;
      let alignment = 1n;
      for (const file of fresh) {
        const power = file.metadata.memoryAlignment;
        if (power >= (this.#options.address === "i32" ? 32 : 64))
          throw new Error("unsupported dynamic memory alignment");
        const aligned = 1n << BigInt(power);
        if (aligned > alignment) alignment = aligned;
        size += BigInt(file.metadata.memorySize) + aligned - 1n;
      }
      if (size > BigInt(this.#options.maximumPages) * 65536n)
        throw new Error("dynamic allocation exceeds process capacity");
      if (fresh.length)
        allocation = this.#call("__wasm_dlopen_allocate", this.#word(size), this.#word(alignment));
      if (allocation !== undefined && !this.#unsigned(allocation))
        throw new Error("cannot allocate dynamic data");
      const base = allocation === undefined ? 1n : this.#unsigned(allocation);
      const tableAddress = this.#options.tableType.address;
      const tableLimit =
        this.#options.tableType.maximum ?? 1n << BigInt(tableAddress === "i32" ? 32 : 64);
      const planned = plan_dylink_layout(
        fresh.map((file) => file.metadata),
        { cursor: base, limit: base + size, address: this.#options.address },
        { cursor: this.#cursor, limit: tableLimit, address: tableAddress },
      );
      const extra = files.reduce(
        (count, file) =>
          count +
          WebAssembly.Module.exports(file.module).filter((entry) => entry.kind === "function")
            .length +
          read_wasm_dynamic_imports(file.bytes).filter((entry) => entry.module === "GOT.func")
            .length,
        0,
      );
      const tableEnd = planned.tableEnd + BigInt(extra);
      if (tableEnd > tableLimit) throw new Error("dynamic table exceeds process capacity");
      this.#grow(tableEnd);
      const group = link_dylink_graph({
        root: root.key,
        files: new Map(files.map((file) => [file.key, file.bytes])),
        memory: this.#options.memory,
        table: this.#table,
        stack: this.#stack,
        memoryMaximumPages: BigInt(this.#options.maximumPages),
        tableMaximumElements: this.#options.tableType.maximum,
        memoryArena: { cursor: base, limit: base + size, address: this.#options.address },
        tableArena: { cursor: this.#cursor, limit: tableEnd, address: tableAddress },
        externalSymbols: this.#symbols,
        functionPointers: this.#pointers,
        reuse: this.#reuse,
        resolveDependency: (name, parent) => local.get(parent)!.dependencies.get(name)!,
        isControlFlow: this.#options.isControlFlow,
      });
      this.#cursor = group.layout.tableEnd;
      committed = true;
      group.initialize();
      const handle = this.#handles.size + 2;
      this.#handles.set(handle, group);
      this.#groups.set(root.key, { group, handle });
      for (const file of files) this.#files.set(file.key, file);
      for (const [name, key] of aliases) this.#aliases.set(name, key);
      for (const [key, record] of group.records) this.#reuse.set(key, record);
      if (flags & 256) this.#promote(group);
      allocation = undefined; // Resident until exec/exit, including dlclose.
      return this.#word(BigInt(handle));
    } catch (error) {
      if (committed && !this.#options.isControlFlow(error))
        return this.#failure(
          error instanceof DylinkInitializationError ? error : new DylinkInitializationError(error),
        );
      if (!this.#options.isControlFlow(error) && !(error instanceof DylinkInitializationError)) {
        try {
          for (const pin of pins) this.#unpin(pin);
        } catch (cleanup) {
          return this.#failure(cleanup);
        }
      }
      if (
        allocation !== undefined &&
        !this.#options.isControlFlow(error) &&
        !(error instanceof DylinkInitializationError)
      )
        this.#call("__wasm_dlopen_deallocate", allocation);
      return this.#failure(error);
    } finally {
      if (acquired) this.#busy = false;
    }
  }
  symbol(handle: WasmAddress, namePointer: WasmAddress): WasmAddress {
    try {
      const key = this.#unsigned(handle);
      const name = this.#string(namePointer);
      const symbol =
        key < 2n ? this.#symbols.get(name) : this.#handles.get(Number(key))?.lookup(name);
      if (!symbol) throw new Error(`symbol not found or invalid handle: ${name}`);
      return this.#word(this.#address(symbol));
    } catch (error) {
      return this.#failure(error);
    }
  }
  valid(handle: WasmAddress): number {
    const key = this.#unsigned(handle);
    const valid = key === 1n || this.#handles.has(Number(key));
    if (!valid) this.#error = "Invalid dynamic library handle";
    return valid ? 1 : 0;
  }
  error(pointer: WasmAddress, length: WasmAddress): number {
    try {
      const size = wasm_size_to_number(length);
      const bytes = memory_bytes(this.#options.memory, pointer, size);
      if (!bytes) return -14;
      if (size) {
        const message = new TextEncoder().encode(this.#error);
        const count = Math.min(message.length, size - 1);
        bytes.set(message.subarray(0, count));
        bytes[count] = 0;
      }
      return 0;
    } catch {
      return -14;
    }
  }
}
