// SPDX-License-Identifier: MIT
import {
  DylinkInitializationError,
  link_dylink_graph,
  type DylinkExternalSymbol,
  type DylinkModuleRecord,
} from "./dylink_linker.ts";
import { plan_dylink_layout } from "./dylink.ts";
import { prepare_dylink_call_metadata } from "./dylink_call_metadata.ts";
import { create_dylink_call_wrapper } from "./dylink_call_wrapper.ts";
import { decode_linux_bytes, encode_linux_string } from "./linux-string.ts";
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
type ObjectHandle = { group: Group; root: string; handle: bigint };
type File = {
  pin: number;
  key: string;
  path: string;
  bytes: Uint8Array<ArrayBuffer>;
  module: WebAssembly.Module;
  metadata: WasmDylink;
  dependencies: Map<string, string>;
  handle?: bigint;
};
type Options = {
  main: WebAssembly.Instance;
  memory: WebAssembly.Memory;
  address: WasmAddressType;
  maximumPages: number;
  tableType: WasmTableType;
  signatures: ReadonlyMap<string, string>;
  functionMetadata?: ReadonlyMap<string, { signature: string; imported: boolean }>;
  privateExports?: ReadonlySet<string>;
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
  readonly #reuse = new Map<string, DylinkModuleRecord>();
  readonly #groups = new Map<string, ObjectHandle>();
  readonly #handles = new Map<bigint, ObjectHandle>();
  readonly #globalOrder: string[] = [];
  readonly #caller = new WebAssembly.Global({ value: "i32", mutable: true }, 0);
  readonly #owners = new Map<string, number>();
  readonly #ownerNames = new Map<number, string>();
  readonly #functions = new Map<CallableFunction, { owner: number | null; signature: string }>();
  readonly #wrappers = new Map<CallableFunction, CallableFunction>();
  #nextOwner = 1;
  #mainHandle = 0n;
  #lastMap = 0n;
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
    if (options.functionMetadata)
      this.#registerFunctions(0, options.main, options.functionMetadata);
    for (const [name, value] of Object.entries(options.main.exports)) {
      if (options.privateExports?.has(name)) continue;
      if (typeof value === "function") {
        const signature = options.signatures.get(name);
        if (signature && !this.#functions.has(value))
          this.#functions.set(value, { owner: 0, signature });
        this.#symbols.set(name, {
          value,
          signature,
          address: this.#pointers.get(value),
        });
      } else if (
        value instanceof WebAssembly.Global &&
        (typeof value.value === "number" || typeof value.value === "bigint")
      )
        this.#symbols.set(name, { value, address: this.#unsigned(value.value) });
    }
    // dlsym executes in the main libc, but its lookup scope belongs to the
    // module which called it. All other C function boundaries keep their owner.
    const dlsym = options.main.exports.dlsym;
    if (typeof dlsym === "function") {
      const info = this.#functions.get(dlsym);
      if (info) this.#functions.set(dlsym, { ...info, owner: null });
    }
    this.#settleTable();
  }
  #owner(name: string) {
    const existing = this.#owners.get(name);
    if (existing !== undefined) return existing;
    if (this.#nextOwner > 0xffffffff) throw new RangeError("dynamic caller capacity exhausted");
    const owner = this.#nextOwner++;
    this.#owners.set(name, owner);
    this.#ownerNames.set(owner, name);
    return owner;
  }
  #registerFunctions(
    owner: number,
    instance: WebAssembly.Instance,
    metadata: ReadonlyMap<string, { signature: string; imported: boolean }>,
  ) {
    for (const [name, description] of metadata) {
      const fn = instance.exports[name];
      if (typeof fn !== "function") throw new Error("missing private dynamic function alias");
      if (!this.#functions.has(fn))
        this.#functions.set(fn, {
          owner: description.imported ? null : owner,
          signature: description.signature,
        });
    }
  }
  #callable(fn: CallableFunction): CallableFunction {
    const info = this.#functions.get(fn);
    if (!info || info.owner === null) return fn;
    const existing = this.#wrappers.get(fn);
    if (existing) return existing;
    const wrapped = create_dylink_call_wrapper(info.signature, fn, this.#caller, info.owner);
    this.#wrappers.set(fn, wrapped);
    this.#wrappers.set(wrapped, wrapped);
    this.#functions.set(wrapped, info);
    const pointer = this.#pointers.get(fn);
    if (pointer !== undefined) this.#pointers.set(wrapped, pointer);
    return wrapped;
  }
  #settleTable() {
    const set = this.#table.set as unknown as (index: WasmAddress, fn: CallableFunction) => void;
    for (let index = 3n; index < BigInt(this.#table.length); index++) {
      const address = this.#word(index, this.#options.tableType.address);
      const fn = wasm_table_get(this.#table, address);
      if (!fn) continue;
      const wrapped = this.#callable(fn);
      const pointer = this.#pointers.get(fn) ?? this.#pointers.get(wrapped) ?? index;
      this.#pointers.set(fn, pointer);
      this.#pointers.set(wrapped, pointer);
      if (wrapped !== fn) set.call(this.#table, address, wrapped);
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
    const previous = this.#caller.value;
    this.#caller.value = 0;
    try {
      return fn(...args) as WasmAddress;
    } catch (error) {
      if (this.#options.isControlFlow(error)) throw error;
      throw new DylinkInitializationError(error);
    } finally {
      this.#caller.value = previous;
    }
  }
  #string(pointer: WasmAddress): string {
    const start = wasm_pointer_to_number(pointer);
    const buffer = this.#options.memory.buffer;
    if (start >= buffer.byteLength) throw new Error("invalid dynamic string pointer");
    const view = new Uint8Array(buffer, start, Math.min(4096, buffer.byteLength - start));
    const end = view.indexOf(0);
    if (end < 0) throw new Error("unterminated dynamic string");
    return decode_linux_bytes(view.subarray(0, end));
  }
  #failure(error: unknown): WasmAddress {
    if (this.#options.isControlFlow(error)) throw error;
    if (error instanceof DylinkInitializationError) {
      this.#caller.value = 0;
      this.#options.fatal(error);
    }
    this.#error = error instanceof Error ? error.message : "Dynamic loader failure";
    return this.#word(0n);
  }
  #read(path: string, known: ReadonlyMap<string, File>): File {
    const encoded = encode_linux_string(path + "\0");
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
    const fn = this.#callable(symbol.value);
    let pointer = this.#pointers.get(fn);
    if (pointer === undefined) {
      pointer = this.#cursor;
      this.#grow(pointer + 1n);
      const set = this.#table.set as unknown as (index: WasmAddress, fn: CallableFunction) => void;
      set.call(this.#table, this.#word(pointer, this.#options.tableType.address), fn);
      this.#cursor++;
      this.#pointers.set(symbol.value, pointer);
      this.#pointers.set(fn, pointer);
    }
    symbol.address = pointer;
    return pointer;
  }
  #linkMap(name: string, base: bigint): bigint {
    // The public musl link_map consists of five pointer-width words. The SDK
    // checks this layout at compile time. Wasm has no ELF dynamic section:
    // l_ld is NULL; l_addr describes data, never a native instruction address.
    const wordBytes = this.#options.address === "i64" ? 8 : 4;
    const encoded = encode_linux_string(name + "\0");
    const pointer = this.#call(
      "__wasm_dlopen_allocate",
      this.#word(BigInt(5 * wordBytes + encoded.length)),
      this.#word(BigInt(wordBytes)),
    );
    const address = this.#unsigned(pointer);
    if (!address) throw new Error("cannot allocate dynamic object metadata");
    const bytes = memory_bytes(this.#options.memory, pointer, 5 * wordBytes + encoded.length);
    const previous = this.#lastMap
      ? memory_bytes(this.#options.memory, this.#word(this.#lastMap), 5 * wordBytes)
      : undefined;
    if (!bytes || (this.#lastMap && !previous))
      throw new DylinkInitializationError(new Error("invalid dynamic object metadata backing"));
    const store = (target: Uint8Array, slot: number, value: bigint) => {
      const view = new DataView(target.buffer, target.byteOffset, target.byteLength);
      if (wordBytes === 8) view.setBigUint64(slot * wordBytes, value, true);
      else view.setUint32(slot * wordBytes, Number(value), true);
    };
    bytes.fill(0);
    store(bytes, 0, base);
    store(bytes, 1, address + BigInt(5 * wordBytes));
    store(bytes, 4, this.#lastMap);
    bytes.set(encoded, 5 * wordBytes);
    if (previous) store(previous, 3, address);
    this.#lastMap = address;
    return address;
  }
  #promote(group: Group, root: string) {
    const pending = group
      .symbolNamesFrom(root)
      .filter((name) => !this.#symbols.has(name))
      .map((name) => [name, group.lookupFrom(root, name)!] as const);
    for (const [name, symbol] of pending) this.#symbols.set(name, symbol);
    const queue = [root];
    const visited = new Set<string>();
    for (let index = 0; index < queue.length; index++) {
      const key = queue[index]!;
      if (visited.has(key)) continue;
      visited.add(key);
      if (!this.#globalOrder.includes(key)) this.#globalOrder.push(key);
      for (const dependency of this.#files.get(key)!.dependencies.values()) queue.push(dependency);
    }
  }
  open(pathPointer: WasmAddress, flags: number): WasmAddress {
    let allocation: WasmAddress | undefined;
    let acquired = false;
    let committed = false;
    const pins: number[] = [];
    try {
      if (flags & ~0x1107 || !(flags & 3)) throw new Error("invalid dlopen mode");
      if (!this.#unsigned(pathPointer) && this.#mainHandle) return this.#word(this.#mainHandle);
      if (this.#busy) throw new Error("recursive dynamic loading is not supported yet");
      this.#busy = true;
      acquired = true;
      if (!this.#mainHandle) this.#mainHandle = this.#linkMap("", 0n);
      if (!this.#unsigned(pathPointer)) return this.#word(this.#mainHandle);
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
        if (flags & 256) this.#promote(old.group, old.root);
        for (const [name, key] of aliases) this.#aliases.set(name, key);
        this.#busy = false;
        acquired = false;
        old.group.ensureInitializedFrom(old.root);
        return this.#word(old.handle);
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
      const tableStart = this.#cursor;
      // A Wasm start section can call main code which performs dlsym. Keep its
      // new canonical pointers beyond this batch's initialization/clear range.
      this.#cursor = tableEnd;
      let group: Group;
      const functionMetadata = new Map<
        string,
        ReadonlyMap<string, { signature: string; imported: boolean }>
      >();
      try {
        group = link_dylink_graph({
          root: root.key,
          files: new Map(files.map((file) => [file.key, file.bytes])),
          memory: this.#options.memory,
          table: this.#table,
          stack: this.#stack,
          memoryMaximumPages: BigInt(this.#options.maximumPages),
          tableMaximumElements: this.#options.tableType.maximum,
          memoryArena: { cursor: base, limit: base + size, address: this.#options.address },
          tableArena: { cursor: tableStart, limit: tableEnd, address: tableAddress },
          externalSymbols: this.#symbols,
          functionPointers: this.#pointers,
          initialThreadLocalTls: true,
          reuse: this.#reuse,
          resolveDependency: (name, parent) => local.get(parent)!.dependencies.get(name)!,
          isControlFlow: this.#options.isControlFlow,
          execution: {
            prepare: (name, bytes) => {
              const prepared = prepare_dylink_call_metadata(bytes);
              functionMetadata.set(name, prepared.functions);
              return new WebAssembly.Module(prepared.bytes);
            },
            instantiate: (name, action) => {
              const previous = this.#caller.value;
              this.#caller.value = this.#owner(name) | 0;
              try {
                return action();
              } finally {
                this.#caller.value = previous;
              }
            },
            register: (name, instance) =>
              this.#registerFunctions(this.#owner(name), instance, functionMetadata.get(name)!),
            callable: (fn) => this.#callable(fn),
            settleTable: () => this.#settleTable(),
          },
        });
      } catch (error) {
        // Ordinary errors precede instantiation and reentrant user code. Traps
        // and control transfers leave this instance, so never roll them back.
        if (!this.#options.isControlFlow(error) && !(error instanceof DylinkInitializationError))
          this.#cursor = tableStart;
        throw error;
      }
      if (this.#cursor === tableEnd || group.layout.tableEnd > this.#cursor)
        this.#cursor = group.layout.tableEnd;
      committed = true;
      for (const file of files) {
        if (file.handle !== undefined) continue;
        file.handle = this.#linkMap(file.path, group.records.get(file.key)!.base);
        const object = { group, root: file.key, handle: file.handle };
        this.#handles.set(file.handle, object);
        this.#groups.set(file.key, object);
      }
      for (const file of files) this.#files.set(file.key, file);
      for (const [name, key] of aliases) this.#aliases.set(name, key);
      for (const [key, record] of group.records) this.#reuse.set(key, record);
      if (flags & 256) this.#promote(group, root.key);
      allocation = undefined; // Resident until exec/exit, including dlclose.
      // Instances, GOT/TLS relocations and file ownership are complete. Publish
      // before constructors so recursive dlopen sees the same records and can
      // initialize other pending dependencies exactly once. Start/I/O/allocator
      // callbacks above remain guarded against reentrant graph construction.
      this.#busy = false;
      acquired = false;
      group.ensureInitialized();
      return this.#word(root.handle!);
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
      const object = this.#handles.get(key);
      const next = (1n << BigInt(this.#options.address === "i64" ? 64 : 32)) - 1n;
      const symbol =
        key === next
          ? this.#nextSymbol(name)
          : key === 0n || key === this.#mainHandle
            ? this.#symbols.get(name)
            : object?.group.lookupFrom(object.root, name);
      if (!symbol) throw new Error(`symbol not found or invalid handle: ${name}`);
      return this.#word(this.#address(symbol));
    } catch (error) {
      return this.#failure(error);
    }
  }
  #nextSymbol(name: string): DylinkExternalSymbol | undefined {
    const owner = Number(this.#caller.value) >>> 0;
    const caller = owner ? this.#ownerNames.get(owner) : undefined;
    if (owner && (!caller || !this.#groups.has(caller)))
      throw new Error("calling dynamic object is not published");
    const loaded = [...this.#groups.keys()];
    const first = owner ? loaded[loaded.indexOf(caller!) + 1] : undefined;
    if (owner && first === undefined) return undefined;
    // Match the existing musl lookup model: begin at the next link-map object,
    // then follow that object's global-symbol chain. A local object has no
    // global successor until it is promoted with RTLD_GLOBAL.
    const start = first === undefined ? 0 : this.#globalOrder.indexOf(first);
    const scope = start < 0 ? [first!] : this.#globalOrder.slice(start);
    for (const key of scope) {
      const object = this.#groups.get(key)!;
      const found = object.group.lookupOwn(object.root, name);
      if (found) return found;
    }
    return undefined;
  }
  valid(handle: WasmAddress): number {
    const key = this.#unsigned(handle);
    const valid = (key !== 0n && key === this.#mainHandle) || this.#handles.has(key);
    if (!valid) this.#error = "Invalid dynamic library handle";
    return valid ? 1 : 0;
  }
  error(pointer: WasmAddress, length: WasmAddress): number {
    try {
      const size = wasm_size_to_number(length);
      const bytes = memory_bytes(this.#options.memory, pointer, size);
      if (!bytes) return -14;
      if (size) {
        const message = encode_linux_string(this.#error);
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
