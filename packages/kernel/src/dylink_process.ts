// SPDX-License-Identifier: MIT
import {
  DylinkInitializationError,
  link_dylink_graph,
  type DylinkExternalTag,
  type DylinkExternalSymbol,
  type DylinkLazyFunction,
  type DylinkModuleRecord,
  type DylinkSymbolType,
} from "./dylink_linker.ts";
import { plan_dylink_layout } from "./dylink.ts";
import { prepare_dylink_call_metadata } from "./dylink_call_metadata.ts";
import {
  create_dylink_call_wrapper,
  create_dylink_tail_call_wrapper,
} from "./dylink_call_wrapper.ts";
import {
  resolve_dylink_address,
  type DylinkAddressFunction,
  type DylinkAddressObject,
} from "./dylink_address.ts";
import { decode_linux_bytes, encode_linux_string } from "./linux-string.ts";
import {
  read_wasm_dylink,
  read_wasm_dynamic_imports,
  prepare_wasm_dynamic_tail_calls,
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
  tagSignatures?: ReadonlyMap<string, string>;
  functionMetadata?: ReadonlyMap<string, { signature: string; imported: boolean }>;
  privateExports?: ReadonlySet<string>;
  userPoll?: { checkpoint: () => number; threadPointer: WebAssembly.Global };
  blocked(): boolean;
  isControlFlow(error: unknown): boolean;
  fatal(error: unknown): never;
  pinFile(fd: number, device: bigint, inode: bigint): number;
  unpinFile(id: number): number;
};

const mainControlGlobals = new Set([
  "__stack_pointer",
  "__tls_base",
  "__tls_size",
  "__tls_align",
  "__memory_base",
  "__table_base",
  "__table_base32",
  "__heap_base",
  "__heap_end",
  "__data_end",
  "__global_base",
  "__wasm_first_page_end",
  "__dso_handle",
]);

// Only failures to open a path may advance to a later search directory.
// An opened object's admission, read or format failure must retain precedence.
class DylinkSearchMiss extends Error {}

/** Per-main-instance execution state. Files come exclusively through the main
 * program's guarded Linux syscalls. Modules remain resident as musl dlclose does;
 * this profile has no Worker publication or fork snapshot protocol yet. */
export class ProcessDylink {
  readonly #options: Options;
  readonly #table: WebAssembly.Table;
  #tailTable: WebAssembly.Table | null = null;
  readonly #stack: WebAssembly.Global;
  readonly #symbols = new Map<string, DylinkExternalSymbol>();
  readonly #tags = new Map<string, DylinkExternalTag>();
  readonly #pointers = new Map<CallableFunction, bigint>();
  readonly #files = new Map<string, File>();
  readonly #aliases = new Map<string, string>();
  readonly #reuse = new Map<string, DylinkModuleRecord>();
  readonly #groups = new Map<string, ObjectHandle>();
  readonly #addressNames = new Map<string, bigint>();
  #lazyFunctions: DylinkLazyFunction[] = [];
  readonly #handles = new Map<bigint, ObjectHandle>();
  readonly #globalOrder: string[] = [];
  readonly #caller = new WebAssembly.Global({ value: "i32", mutable: true }, 0);
  readonly #owners = new Map<string, number>();
  readonly #ownerNames = new Map<number, string>();
  readonly #functions = new Map<
    CallableFunction,
    { owner: number | null; addressOwner?: number; signature?: string }
  >();
  readonly #wrappers = new Map<CallableFunction, CallableFunction>();
  readonly #tailWrappers = new Map<CallableFunction, CallableFunction>();
  readonly #originals = new Map<CallableFunction, CallableFunction>();
  #nextOwner = 1;
  #mainHandle = 0n;
  #lastMap = 0n;
  #cursor: bigint;
  #busy = false;
  #addressBusy = false;
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
    for (const [name, signature] of options.tagSignatures ?? []) {
      const value = options.main.exports[name];
      if (typeof WebAssembly.Tag !== "function" || !(value instanceof WebAssembly.Tag))
        throw new Error(`missing dynamic main exception tag: ${name}`);
      this.#tags.set(name, { value, signature });
    }
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
        if (!this.#functions.has(value))
          this.#functions.set(value, {
            owner: 0,
            addressOwner: 0,
            ...(signature === undefined ? {} : { signature }),
          });
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
      if (!this.#functions.has(fn)) {
        this.#functions.set(
          fn,
          description.imported
            ? { owner: null, signature: description.signature }
            : { owner, addressOwner: owner, signature: description.signature },
        );
      }
    }
  }
  #ensureTailTable() {
    if (this.#tailTable) return;
    const address = this.#options.tableType.address;
    const initial = BigInt(this.#table.length);
    const maximum = this.#options.tableType.maximum;
    const descriptor = {
      element: "anyfunc",
      address,
      initial: address === "i64" ? initial : Number(initial),
      ...(maximum === undefined ? {} : { maximum: address === "i64" ? maximum : Number(maximum) }),
    } as unknown as WebAssembly.TableDescriptor;
    const table = new WebAssembly.Table(descriptor);
    if (BigInt(table.length) !== initial) throw new Error("incompatible dynamic tail table");
    this.#tailTable = table;
    this.#settleTable();
  }
  #callable(fn: CallableFunction): CallableFunction {
    const raw = this.#originals.get(fn) ?? fn;
    const info = this.#functions.get(raw) ?? this.#functions.get(fn);
    if (!info || info.owner === null || !info.signature) return fn;
    const existing = this.#wrappers.get(raw);
    if (existing) return existing;
    const wrapped = create_dylink_call_wrapper(info.signature, raw, this.#caller, info.owner);
    this.#wrappers.set(raw, wrapped);
    this.#wrappers.set(wrapped, wrapped);
    this.#originals.set(wrapped, raw);
    this.#functions.set(wrapped, info);
    const pointer = this.#pointers.get(raw) ?? this.#pointers.get(fn);
    if (pointer !== undefined) this.#pointers.set(wrapped, pointer);
    return wrapped;
  }
  #tailCallable(fn: CallableFunction): CallableFunction {
    const raw = this.#originals.get(fn) ?? fn;
    const info = this.#functions.get(raw) ?? this.#functions.get(fn);
    if (!info || info.owner === null || !info.signature) return raw;
    const existing = this.#tailWrappers.get(raw);
    if (existing) return existing;
    const wrapped = create_dylink_tail_call_wrapper(info.signature, raw, this.#caller, info.owner);
    this.#tailWrappers.set(raw, wrapped);
    this.#tailWrappers.set(wrapped, wrapped);
    return wrapped;
  }
  #settleTable() {
    const set = this.#table.set as unknown as (index: WasmAddress, fn: CallableFunction) => void;
    const tailTable = this.#tailTable;
    const tailSet = tailTable?.set as
      | ((index: WasmAddress, fn: CallableFunction | null) => void)
      | undefined;
    if (tailTable && BigInt(tailTable.length) !== BigInt(this.#table.length))
      throw new Error("dynamic canonical and tail tables diverged");
    for (let index = 3n; index < BigInt(this.#table.length); index++) {
      const address = this.#word(index, this.#options.tableType.address);
      const fn = wasm_table_get(this.#table, address);
      if (!fn) {
        if (tailTable && wasm_table_get(tailTable, address) !== null)
          tailSet!.call(tailTable, address, null);
        continue;
      }
      const wrapped = this.#callable(fn);
      const tailWrapped = tailTable ? this.#tailCallable(fn) : undefined;
      const pointer = this.#pointers.get(fn) ?? this.#pointers.get(wrapped) ?? index;
      this.#pointers.set(fn, pointer);
      this.#pointers.set(wrapped, pointer);
      if (wrapped !== fn) set.call(this.#table, address, wrapped);
      if (tailTable && tailWrapped && wasm_table_get(tailTable, address) !== tailWrapped)
        tailSet!.call(tailTable, address, tailWrapped);
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
  #blockedFailure() {
    if (!this.#options.blocked()) return false;
    this.#error = "dynamic loading is disabled while a vfork child is active";
    return true;
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
    const current = BigInt(this.#table.length);
    const tailTable = this.#tailTable;
    if (tailTable && BigInt(tailTable.length) !== current)
      throw new DylinkInitializationError(new Error("dynamic canonical and tail tables diverged"));
    if (end <= current) return;
    const delta = this.#word(end - current, this.#options.tableType.address);
    const grow = (table: WebAssembly.Table) =>
      (table.grow as unknown as (delta: WasmAddress) => WasmAddress).call(table, delta);
    try {
      if (tailTable) grow(tailTable);
      grow(this.#table);
    } catch (error) {
      if (tailTable && BigInt(tailTable.length) !== BigInt(this.#table.length))
        throw new DylinkInitializationError(
          new Error("dynamic canonical and tail table growth diverged", { cause: error }),
        );
      throw error;
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
      const address = this.#word(pointer, this.#options.tableType.address);
      set.call(this.#table, address, fn);
      if (this.#tailTable) {
        const tail = this.#tailCallable(symbol.value as CallableFunction);
        const tailSet = this.#tailTable.set as unknown as (
          index: WasmAddress,
          fn: CallableFunction,
        ) => void;
        tailSet.call(this.#tailTable, address, tail);
      }
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
  #assertLazyFunctionType(name: string, type: DylinkSymbolType, signature: string) {
    if (type.kind !== "function" || type.signature !== signature)
      throw new Error(`incompatible lazy function provider: ${name}`);
  }
  #validateLazyFunctionTypes(types: ReadonlyMap<string, DylinkSymbolType>) {
    for (const pending of this.#lazyFunctions) {
      const existing = this.#symbols.get(pending.name);
      if (existing) {
        this.#assertLazyFunctionType(
          pending.name,
          {
            kind: typeof existing.value === "function" ? "function" : "global",
            signature: existing.signature,
          },
          pending.signature,
        );
        continue;
      }
      const candidate = types.get(pending.name);
      if (candidate) this.#assertLazyFunctionType(pending.name, candidate, pending.signature);
    }
  }
  #bindLazyFunctions() {
    const unresolved: DylinkLazyFunction[] = [];
    for (const pending of this.#lazyFunctions) {
      const symbol = this.#symbols.get(pending.name);
      if (!symbol) {
        unresolved.push(pending);
        continue;
      }
      this.#assertLazyFunctionType(
        pending.name,
        {
          kind: typeof symbol.value === "function" ? "function" : "global",
          signature: symbol.signature,
        },
        pending.signature,
      );
      pending.target.value = this.#word(this.#address(symbol), this.#options.tableType.address);
    }
    this.#lazyFunctions = unresolved;
  }
  open(pathPointer: WasmAddress, flags: number): WasmAddress {
    if (this.#blockedFailure()) return this.#word(0n);
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
        // Descriptor names can refer to a different inode after close/reuse.
        // Always reopen them and deduplicate by the pinned file identity.
        const descriptorPath = /^\/(?:proc\/self\/fd|dev\/fd)\/[0-9]+$/.test(name);
        const existing = descriptorPath ? undefined : aliases.get(name);
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
          const known = descriptorPath ? undefined : aliases.get(candidate);
          if (known && local.has(known)) return local.get(known)!;
          try {
            const file = this.#read(candidate, local);
            if (local.has(file.key)) {
              if (!descriptorPath) {
                aliases.set(candidate, file.key);
                if (!aliases.has(name)) aliases.set(name, file.key);
              }
              return local.get(file.key)!;
            }
            newBytes += file.bytes.length;
            if (newBytes > 64 * 1024 * 1024) {
              this.#unpin(file.pin);
              throw new Error("dynamic graph exceeds profile capacity");
            }
            pins.push(file.pin);
            local.set(file.key, file);
            if (!descriptorPath) {
              aliases.set(candidate, file.key);
              if (!aliases.has(name)) aliases.set(name, file.key);
              const basename = file.path.slice(file.path.lastIndexOf("/") + 1);
              if (!aliases.has(basename)) aliases.set(basename, file.key);
            }
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
        if (flags & 256) {
          this.#validateLazyFunctionTypes(old.group.symbolTypesFrom(old.root));
          this.#promote(old.group, old.root);
          this.#bindLazyFunctions();
        }
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
      const externalSymbolNames = new Set<string>();
      for (const file of files) {
        for (const entry of read_wasm_dynamic_imports(file.bytes)) {
          if (entry.module === "env" || entry.module === "GOT.func" || entry.module === "GOT.mem")
            externalSymbolNames.add(entry.name);
        }
        for (const entry of WebAssembly.Module.exports(file.module))
          externalSymbolNames.add(entry.name);
      }
      const loadExternalSymbols = new Map<string, DylinkExternalSymbol>();
      for (const name of externalSymbolNames) {
        const symbol = this.#symbols.get(name);
        if (symbol) loadExternalSymbols.set(name, { ...symbol });
      }
      let tailTableRequired = false;
      for (const file of fresh) {
        const prepared = prepare_wasm_dynamic_tail_calls(file.bytes);
        tailTableRequired ||= prepared.tailTableRequired;
      }
      if (tailTableRequired) this.#ensureTailTable();
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
      const tableStart = this.#cursor;
      // A Wasm start section can call main code which performs dlsym. Keep its
      // new canonical pointers beyond this batch's initialization/clear range.
      this.#cursor = tableEnd;
      let group: Group;
      const hostFunctions = this.#options.userPoll
        ? new Map<string, ReadonlyMap<string, CallableFunction>>([
            ["linux_user_poll_v1", new Map([["checkpoint", this.#options.userPoll.checkpoint]])],
            ["linux_user_poll_v2", new Map([["checkpoint", this.#options.userPoll.checkpoint]])],
          ])
        : undefined;
      const hostGlobals = this.#options.userPoll
        ? new Map<string, ReadonlyMap<string, WebAssembly.Global>>([
            [
              "linux_user_poll_v2",
              new Map([["thread_pointer", this.#options.userPoll.threadPointer]]),
            ],
          ])
        : undefined;
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
          tailTable: this.#tailTable ?? undefined,
          stack: this.#stack,
          memoryMaximumPages: BigInt(this.#options.maximumPages),
          tableMaximumElements: this.#options.tableType.maximum,
          memoryArena: { cursor: base, limit: base + size, address: this.#options.address },
          tableArena: { cursor: tableStart, limit: tableEnd, address: tableAddress },
          hostFunctions,
          hostGlobals,
          externalSymbols: loadExternalSymbols,
          externalTags: this.#tags,
          functionPointers: this.#pointers,
          initialThreadLocalTls: true,
          lazyFunctions: !!(flags & 1),
          validateSymbols: (types) => {
            if (flags & 256) this.#validateLazyFunctionTypes(types);
          },
          prepareTable: (minimum) => {
            const required = minimum > tableEnd ? minimum : tableEnd;
            if (required > tableLimit) throw new Error("dynamic table exceeds process capacity");
            this.#grow(required);
          },
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
            tailCallable: (fn) => this.#tailCallable(fn),
            settleTable: () => this.#settleTable(),
          },
        });
      } catch (error) {
        // Ordinary errors precede instantiation and reentrant user code. Traps
        // and control transfers leave this instance, so never roll them back.
        if (!this.#options.isControlFlow(error) && !(error instanceof DylinkInitializationError)) {
          this.#cursor = tableStart;
          const set = this.#table.set as unknown as (index: WasmAddress, fn: null) => void;
          const tailSet = this.#tailTable?.set as
            | ((index: WasmAddress, fn: null) => void)
            | undefined;
          for (
            let index = tableStart;
            index < tableEnd && index < BigInt(this.#table.length);
            index++
          ) {
            const address = this.#word(index, tableAddress);
            set.call(this.#table, address, null);
            tailSet?.call(this.#tailTable!, address, null);
          }
        }
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
      for (const pending of group.lazyFunctions) this.#lazyFunctions.push(pending);
      if (flags & 256) {
        this.#promote(group, root.key);
        this.#bindLazyFunctions();
      }
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
    if (this.#blockedFailure()) return this.#word(0n);
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
  #addressObjects(): DylinkAddressObject[] {
    const dataSymbols: { name: string; address: bigint }[] = [];
    let mainBase = 0n;
    let mainSize = 0n;
    const readMainBoundary = (name: string): bigint | undefined => {
      const global = this.#options.main.exports[name];
      if (!(global instanceof WebAssembly.Global)) return undefined;
      const value = global.value;
      if (
        (typeof value !== "number" && typeof value !== "bigint") ||
        (typeof value === "number" && !Number.isInteger(value))
      )
        return undefined;
      return this.#unsigned(value);
    };
    const dataStart = readMainBoundary("__global_base");
    const dataEnd = readMainBoundary("__data_end");
    if (
      dataStart !== undefined &&
      dataEnd !== undefined &&
      dataStart <= dataEnd &&
      dataEnd <= BigInt(this.#options.memory.buffer.byteLength)
    ) {
      mainBase = dataStart;
      mainSize = dataEnd - dataStart;
    }
    for (const [name, value] of Object.entries(this.#options.main.exports)) {
      if (
        this.#options.privateExports?.has(name) ||
        mainControlGlobals.has(name) ||
        !(value instanceof WebAssembly.Global)
      )
        continue;
      const globalValue = value.value;
      if (
        (typeof globalValue !== "number" && typeof globalValue !== "bigint") ||
        (typeof globalValue === "number" && !Number.isInteger(globalValue))
      )
        continue;
      dataSymbols.push({ name, address: this.#unsigned(globalValue) });
    }
    const objects: DylinkAddressObject[] = [
      { id: "@main", base: mainBase, memorySize: mainSize, dataSymbols },
    ];
    for (const [key, file] of this.#files) {
      const record = this.#reuse.get(key);
      const loaded = this.#groups.get(key);
      if (!record || !loaded) continue;
      const symbols: { name: string; address: bigint }[] = [];
      for (const entry of WebAssembly.Module.exports(file.module)) {
        if (entry.kind !== "global") continue;
        const symbol = loaded.group.lookupOwn(key, entry.name);
        if (symbol?.value instanceof WebAssembly.Global && symbol.address !== undefined)
          symbols.push({ name: entry.name, address: symbol.address });
      }
      objects.push({
        id: key,
        base: record.base,
        memorySize: BigInt(file.metadata.memorySize),
        dataSymbols: symbols,
      });
    }
    return objects;
  }
  #addressFunction(address: bigint): DylinkAddressFunction | null | undefined {
    if (address <= 0n || address >= BigInt(this.#table.length)) return undefined;
    const tableAddress = this.#word(address, this.#options.tableType.address);
    const fn = wasm_table_get(this.#table, tableAddress);
    if (!fn) return undefined;
    const functionInfo = this.#functions.get(fn);
    if (!functionInfo || functionInfo.addressOwner === undefined) return null;
    const ownerId = functionInfo.addressOwner;
    const owner = ownerId === 0 ? "@main" : this.#ownerNames.get(ownerId);
    if (!owner) return null;
    if (ownerId !== 0 && (!this.#files.has(owner) || !this.#reuse.has(owner))) return null;

    const canonical = this.#pointers.get(fn);
    if (canonical === undefined || canonical >= BigInt(this.#table.length)) return { owner };
    const canonicalFunction = wasm_table_get(
      this.#table,
      this.#word(canonical, this.#options.tableType.address),
    );
    if (
      !canonicalFunction ||
      this.#functions.get(canonicalFunction)?.addressOwner !== ownerId ||
      this.#pointers.get(canonicalFunction) !== canonical
    )
      return { owner };

    const candidates: { name: string; address: bigint }[] = [];
    const addCandidate = (name: string, value: unknown, valueAddress?: bigint) => {
      if (typeof value !== "function" || valueAddress !== canonical) return;
      const valueInfo = this.#functions.get(value);
      if (valueInfo?.addressOwner !== ownerId) return;
      const actual = wasm_table_get(
        this.#table,
        this.#word(canonical, this.#options.tableType.address),
      );
      if (
        !actual ||
        this.#functions.get(actual)?.addressOwner !== ownerId ||
        this.#pointers.get(actual) !== canonical
      )
        return;
      candidates.push({ name, address: canonical });
    };

    if (ownerId === 0) {
      for (const [name, value] of Object.entries(this.#options.main.exports)) {
        if (this.#options.privateExports?.has(name)) continue;
        const symbol = this.#symbols.get(name);
        if (symbol)
          addCandidate(
            name,
            symbol.value,
            symbol.address ?? (typeof value === "function" ? this.#pointers.get(value) : undefined),
          );
      }
    } else {
      const loaded = this.#groups.get(owner);
      const file = this.#files.get(owner);
      const instance = loaded?.group.instances.get(owner);
      if (!loaded || !file || !instance) return { owner };
      for (const entry of WebAssembly.Module.exports(file.module)) {
        if (entry.kind !== "function") continue;
        const raw = instance.exports[entry.name];
        if (typeof raw !== "function") continue;
        const symbol = loaded.group.lookupOwn(owner, entry.name);
        if (!symbol || typeof symbol.value !== "function") continue;
        const rawOwner = this.#functions.get(raw)?.addressOwner;
        if (rawOwner !== undefined && rawOwner !== ownerId) continue;
        addCandidate(entry.name, symbol.value, symbol.address);
      }
    }
    candidates.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const symbol = candidates[0];
    return symbol ? { owner, symbol } : { owner };
  }
  #addressName(name: string): bigint | undefined {
    const existing = this.#addressNames.get(name);
    if (existing !== undefined) return existing;
    const encoded = encode_linux_string(name + "\0");
    const pointer = this.#call(
      "__wasm_dlopen_allocate",
      this.#word(BigInt(encoded.length)),
      this.#word(1n),
    );
    const address = this.#unsigned(pointer);
    if (!address) return undefined;
    const target = memory_bytes(this.#options.memory, pointer, encoded.length);
    if (!target)
      throw new DylinkInitializationError(new Error("invalid dynamic symbol name backing"));
    target.set(encoded);
    this.#addressNames.set(name, address);
    return address;
  }
  address(pointer: WasmAddress, info: WasmAddress): number {
    if (this.#blockedFailure()) return 0;
    if (this.#addressBusy) return 0;
    this.#addressBusy = true;
    try {
      const wordBytes = this.#options.address === "i64" ? 8 : 4;
      const size = 4 * wordBytes;
      if (!memory_bytes(this.#options.memory, info, size)) return 0;

      const address = this.#unsigned(pointer);
      const functionMatch = this.#addressFunction(address);
      if (functionMatch === null) return 0;
      const resolved = resolve_dylink_address(address, this.#addressObjects(), functionMatch);
      if (!resolved) return 0;

      let filename: bigint;
      let base = 0n;
      if (resolved.owner === "@main") {
        filename = this.#unsigned(this.#call("__wasm_dlopen_main_path"));
      } else {
        const file = this.#files.get(resolved.owner);
        const record = this.#reuse.get(resolved.owner);
        if (!file?.handle || !record) return 0;
        filename = file.handle + BigInt(5 * wordBytes);
        base = record.base;
      }
      if (!filename) return 0;

      let symbolName = 0n;
      let symbolAddress = 0n;
      if (resolved.symbol) {
        const name = this.#addressName(resolved.symbol.name);
        if (name === undefined) return 0;
        symbolName = name;
        symbolAddress = resolved.symbol.address;
      }
      const maximum = (1n << BigInt(wordBytes * 8)) - 1n;
      if (
        [filename, base, symbolName, symbolAddress].some((value) => value < 0n || value > maximum)
      )
        return 0;

      const output = new Uint8Array(size);
      const view = new DataView(output.buffer);
      const values = [filename, base, symbolName, symbolAddress];
      for (let index = 0; index < values.length; index++) {
        const value = values[index]!;
        if (wordBytes === 8) view.setBigUint64(index * wordBytes, value, true);
        else view.setUint32(index * wordBytes, Number(value), true);
      }
      const target = memory_bytes(this.#options.memory, info, size);
      if (!target) return 0;
      target.set(output);
      return 1;
    } catch (error) {
      if (this.#options.isControlFlow(error)) throw error;
      if (error instanceof DylinkInitializationError) {
        this.#caller.value = 0;
        this.#options.fatal(error);
      }
      return 0;
    } finally {
      this.#addressBusy = false;
    }
  }
  valid(handle: WasmAddress): number {
    if (this.#blockedFailure()) return 0;
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
