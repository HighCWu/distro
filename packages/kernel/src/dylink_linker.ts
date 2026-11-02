// SPDX-License-Identifier: MIT

import { plan_dylink_layout, type DylinkArena } from "./dylink.ts";
import {
  read_wasm_dylink,
  read_wasm_dynamic_imports,
  read_wasm_dynamic_signatures,
  read_wasm_memories,
  type WasmDylink,
} from "./wasm_binary.ts";
import { wasm_table_get } from "./wasm.ts";

/** An error after data/table initialization may follow arbitrary Wasm start or
 * constructor effects. The process owner must terminate, not resume dlopen with
 * a normal recoverable error or retry constructors against partially live data. */
export class DylinkInitializationError extends Error {
  constructor(cause: unknown) {
    super("dynamic module initialization failed; process state is not recoverable", { cause });
    this.name = "DylinkInitializationError";
  }
}

export interface DylinkExternalSymbol {
  value: WebAssembly.ExportValue;
  /** Required for direct function imports; obtained from the owner's module. */
  signature?: string;
  /** Data pointers are absolute; canonical function pointers may be supplied. */
  address?: bigint;
}

/** Link an already fetched, acyclic batch in caller-owned process arenas.
 * File lookup, allocator locking, main-module interposition, worker publication,
 * unload and fork snapshots belong to the process loader, not this component.
 * All modules must be trusted executable files: a Wasm start section runs during
 * instantiation, before relocations/constructors, and can have arbitrary effects.
 */
export function link_dylink_graph(options: {
  root: string;
  files: ReadonlyMap<string, Uint8Array<ArrayBuffer>>;
  memory: WebAssembly.Memory;
  table: WebAssembly.Table;
  /** Actual creation limits, which the JS reflection API does not expose. */
  memoryMaximumPages: bigint;
  tableMaximumElements?: bigint;
  stack: WebAssembly.Global;
  memoryArena: Readonly<DylinkArena>;
  tableArena: Readonly<DylinkArena>;
  hostFunctions?: ReadonlyMap<string, ReadonlyMap<string, CallableFunction>>;
  externalSymbols?: ReadonlyMap<string, DylinkExternalSymbol>;
  reuse?: ReadonlyMap<string, { instance: WebAssembly.Instance; base: bigint; tableBase: bigint }>;
  functionPointers?: Map<CallableFunction, bigint>;
  resolveDependency?(name: string, parent: string): string;
  /** Execution control transfers (exit/exec) must escape initialization intact. */
  isControlFlow?(error: unknown): boolean;
}) {
  const { memory, table, stack, memoryArena, tableArena } = options;
  const modules = new Map<
    string,
    {
      module: WebAssembly.Module;
      metadata: WasmDylink;
      imports: ReturnType<typeof read_wasm_dynamic_imports>;
      signatures: ReturnType<typeof read_wasm_dynamic_signatures>;
      exports: WebAssembly.ModuleExportDescriptor[];
      instance?: WebAssembly.Instance;
      base: bigint;
      tableBase: bigint;
      dependencies: string[];
    }
  >();
  // An iterative DFS bounds traversal by fetched files, not the JavaScript stack.
  const order: string[] = [];
  const active = new Set<string>();
  const pending = [{ name: options.root, finish: false }];
  while (pending.length) {
    const { name, finish } = pending.pop()!;
    if (finish) {
      active.delete(name);
      order.push(name);
      continue;
    }
    if (active.has(name)) throw new Error("cyclic dynamic dependencies are not supported yet");
    if (modules.has(name)) continue;
    const bytes = options.files.get(name);
    if (!bytes) throw new Error(`missing dynamic dependency: ${name}`);
    const module = new WebAssembly.Module(bytes);
    const metadata = read_wasm_dylink(module);
    if (!metadata) throw new Error(`missing dylink.0: ${name}`);
    if (metadata.unknownSubsections.length) throw new Error("unsupported dylink extension");
    if ([...metadata.exports, ...metadata.imports].some((symbol) => symbol.flags & ~0xff))
      throw new Error("dynamic TLS, absolute or unknown symbol flags are not supported yet");
    for (const group of [metadata.exports, metadata.imports]) {
      const flags = new Map<string, number>();
      for (const entry of group) {
        const key = JSON.stringify(["module" in entry ? entry.module : null, entry.name]);
        if (flags.has(key) && flags.get(key) !== entry.flags)
          throw new Error("conflicting dynamic symbol metadata");
        flags.set(key, entry.flags);
      }
    }
    if (read_wasm_memories(bytes).definitions.length)
      throw new Error("dynamic module must not define private memory");
    modules.set(name, {
      module,
      metadata,
      imports: read_wasm_dynamic_imports(bytes),
      signatures: read_wasm_dynamic_signatures(bytes),
      exports: WebAssembly.Module.exports(module),
      base: 0n,
      tableBase: 0n,
      dependencies: metadata.needed.map(
        (dependency) => options.resolveDependency?.(dependency, name) ?? dependency,
      ),
      ...options.reuse?.get(name),
    });
    active.add(name);
    pending.push({ name, finish: true });
    for (const dependency of modules.get(name)!.dependencies.toReversed())
      pending.push({ name: dependency, finish: false });
  }
  const records = order.map((name) => modules.get(name)!);
  const fresh = records.filter((record) => !record.instance);
  type Record = (typeof records)[number];
  type Symbol = { owner?: Record; external?: DylinkExternalSymbol; kind: "function" | "global" };
  const symbols = new Map<string, Symbol>();
  for (const [name, external] of options.externalSymbols ?? []) {
    if (typeof external.value === "function") symbols.set(name, { external, kind: "function" });
    else if (external.value instanceof WebAssembly.Global && external.address !== undefined)
      symbols.set(name, { external, kind: "global" });
  }
  const ownSymbols = new Map<string, Symbol>();
  const valueOf = (symbol: Symbol, name: string) =>
    symbol.owner?.instance?.exports[name] ?? symbol.external?.value;
  const signatureOf = (symbol: Symbol, name: string) =>
    symbol.owner?.signatures.exports.get(name) ?? symbol.external?.signature;
  // Lookup scope and constructor order differ: breadth-first root/NEEDED lookup
  // uses the first definition, including a weak one, as normal ELF lookup does.
  const scope = [options.root];
  const scoped = new Set(scope);
  for (let index = 0; index < scope.length; index++) {
    for (const name of modules.get(scope[index]!)!.dependencies)
      if (!scoped.has(name)) {
        scoped.add(name);
        scope.push(name);
      }
  }
  const internal = new Set([
    "__wasm_call_ctors",
    "__wasm_apply_data_relocs",
    "__wasm_init_memory",
    "__memory_base",
    "__table_base",
    "__table_base32",
    "__stack_pointer",
    "__dso_handle",
    "__heap_base",
    "__heap_end",
    "__global_base",
    "__data_end",
  ]);
  for (const name of scope) {
    const record = modules.get(name)!;
    const flags = new Map(record.metadata.exports.map((symbol) => [symbol.name, symbol.flags]));
    for (const symbol of record.exports) {
      if (symbol.kind !== "function" && symbol.kind !== "global") continue;
      if (internal.has(symbol.name)) continue;
      const attributes = flags.get(symbol.name) ?? 0;
      if (attributes & 6) continue;
      const definition: Symbol = { owner: record, kind: symbol.kind };
      if (!symbols.has(symbol.name)) symbols.set(symbol.name, definition);
      if (!ownSymbols.has(symbol.name)) ownSymbols.set(symbol.name, definition);
    }
  }
  const functionGOT = new Set<string>();
  for (const record of fresh)
    for (const entry of record.imports) {
      const symbol = symbols.get(entry.name);
      // LLD describes the symbol in env even when its only actual import is a
      // GOT address global. An exact namespace entry, when present, takes priority.
      const attributes =
        record.metadata.imports.find(
          (item) => item.module === entry.module && item.name === entry.name,
        ) ??
        (entry.module === "GOT.func" || entry.module === "GOT.mem"
          ? record.metadata.imports.find(
              (item) => item.module === "env" && item.name === entry.name,
            )
          : undefined);
      const weak = !!(attributes && attributes.flags & 1);
      switch (entry.kind) {
        case "memory":
          if (
            entry.module !== "env" ||
            entry.name !== "memory" ||
            entry.type.address !== memoryArena.address ||
            !entry.type.shared
          )
            throw new Error("incompatible dynamic memory import");
          if (entry.type.minimum * 65536n > BigInt(memory.buffer.byteLength))
            throw new Error("dynamic memory minimum exceeds current process memory");
          if (entry.type.maximum !== undefined && options.memoryMaximumPages > entry.type.maximum)
            throw new Error("dynamic memory maximum excludes process memory");
          break;
        case "table":
          if (
            entry.module !== "env" ||
            entry.name !== "__indirect_function_table" ||
            entry.address !== tableArena.address ||
            entry.minimum > BigInt(table.length) ||
            (entry.maximum !== undefined &&
              (options.tableMaximumElements === undefined ||
                options.tableMaximumElements > entry.maximum))
          )
            throw new Error("incompatible dynamic table import");
          break;
        case "function":
          if (options.hostFunctions?.get(entry.module)?.has(entry.name)) {
            if (entry.module === "env" && symbol)
              throw new Error(
                "host/main symbol interposition requires a process-wide lookup scope",
              );
            break;
          }
          if (
            entry.module !== "env" ||
            (!weak && symbol?.kind !== "function") ||
            (symbol && symbol.kind !== "function")
          )
            throw new Error(`unresolved dynamic function: ${entry.module}.${entry.name}`);
          if (
            symbol &&
            signatureOf(symbol, entry.name) !==
              record.signatures.imports.find(
                (item) => item.module === entry.module && item.name === entry.name,
              )?.signature
          )
            throw new Error(`dynamic function signature mismatch: ${entry.name}`);
          break;
        case "global":
          if (entry.module === "env") {
            if (
              !["__memory_base", "__table_base", "__table_base32", "__stack_pointer"].includes(
                entry.name,
              )
            )
              throw new Error(`unsupported dynamic global: ${entry.name}`);
            const address = entry.name === "__table_base32" ? "i32" : memoryArena.address;
            if (entry.value !== address || entry.mutable !== (entry.name === "__stack_pointer"))
              throw new Error("incompatible dynamic base/stack type");
          } else {
            const kind =
              entry.module === "GOT.mem"
                ? "global"
                : entry.module === "GOT.func"
                  ? "function"
                  : null;
            if (
              !kind ||
              !entry.mutable ||
              entry.value !== memoryArena.address ||
              (!weak && symbol?.kind !== kind) ||
              (symbol && symbol.kind !== kind)
            )
              throw new Error(`unresolved dynamic GOT: ${entry.module}.${entry.name}`);
            if (kind === "function") functionGOT.add(entry.name);
          }
      }
    }
  if (
    memoryArena.cursor < 1n ||
    tableArena.cursor < 1n ||
    options.memoryMaximumPages * 65536n < BigInt(memory.buffer.byteLength) ||
    (options.tableMaximumElements !== undefined &&
      options.tableMaximumElements < BigInt(table.length)) ||
    memoryArena.limit > BigInt(memory.buffer.byteLength) ||
    tableArena.limit > BigInt(table.length)
  )
    throw new RangeError("dynamic arenas must already belong to committed process resources");
  const layout = plan_dylink_layout(
    fresh.map((item) => item.metadata),
    memoryArena,
    tableArena,
  );
  // Reserve a worst-case extra canonical slot for each requested function. Some
  // exports already occupy their producer's element segment; reuse those slots.
  const extra = plan_dylink_layout(
    [
      {
        ...records[0]!.metadata,
        memorySize: 0,
        memoryAlignment: 0,
        tableSize:
          functionGOT.size +
          [...ownSymbols.values()].filter((symbol) => symbol.kind === "function").length,
        tableAlignment: 0,
      },
    ],
    { ...memoryArena, cursor: layout.memoryEnd },
    { ...tableArena, cursor: layout.tableEnd },
  );
  for (const [index, record] of fresh.entries()) Object.assign(record, layout.items[index]);
  const word = (value: bigint, type: "i32" | "i64") => (type === "i64" ? value : Number(value));
  const got: { entry: { module: string; name: string }; global: WebAssembly.Global }[] = [];
  let nextSlot = layout.tableEnd;
  const functionPointers = options.functionPointers ?? new Map<CallableFunction, bigint>();
  function functionPointer(fn: CallableFunction): bigint {
    const old = functionPointers.get(fn);
    if (old !== undefined) return old;
    for (const record of records)
      for (
        let index = record.tableBase;
        index < record.tableBase + BigInt(record.metadata.tableSize);
        index++
      ) {
        if (wasm_table_get(table, word(index, tableArena.address)) === fn) {
          functionPointers.set(fn, index);
          return index;
        }
      }
    const index = nextSlot++;
    if (index >= extra.tableEnd) throw new RangeError("dynamic function slot budget exhausted");
    const set = table.set as unknown as (index: number | bigint, value: CallableFunction) => void;
    set.call(table, word(index, tableArena.address), fn);
    functionPointers.set(fn, index);
    return index;
  }
  try {
    const set = table.set as unknown as (index: number | bigint, value: null) => void;
    for (let index = tableArena.cursor; index < extra.tableEnd; index++)
      set.call(table, word(index, tableArena.address), null);
    for (const record of fresh) {
      new Uint8Array(memory.buffer, Number(record.base), record.metadata.memorySize).fill(0);
      const imports: WebAssembly.Imports = Object.create(null);
      for (const entry of record.imports) {
        const group = (imports[entry.module] ??= Object.create(null));
        switch (entry.kind) {
          case "memory":
            group[entry.name] = memory;
            break;
          case "table":
            group[entry.name] = table;
            break;
          case "function": {
            const host = options.hostFunctions?.get(entry.module)?.get(entry.name);
            const definition = symbols.get(entry.name);
            const dependency = definition && valueOf(definition, entry.name);
            group[entry.name] =
              host ??
              (typeof dependency === "function" ? dependency : undefined) ??
              ((...args: unknown[]) => {
                const symbol = symbols.get(entry.name);
                const fn = symbol && valueOf(symbol, entry.name);
                if (typeof fn !== "function")
                  throw new WebAssembly.RuntimeError("unavailable dynamic function");
                return fn(...args);
              });
            break;
          }
          case "global":
            if (entry.module === "env") {
              const base = entry.name === "__memory_base" ? record.base : record.tableBase;
              group[entry.name] =
                entry.name === "__stack_pointer"
                  ? stack
                  : new WebAssembly.Global({ value: entry.value }, word(base, entry.value));
            } else {
              const global = new WebAssembly.Global(
                { value: entry.value, mutable: true },
                word(0n, entry.value),
              );
              group[entry.name] = global;
              got.push({ entry, global });
            }
        }
      }
      record.instance = new WebAssembly.Instance(record.module, imports);
    }
    for (const { entry, global } of got) {
      const symbol = symbols.get(entry.name);
      if (!symbol) continue; // Weak undefined GOT retains null.
      const value = valueOf(symbol, entry.name);
      const address =
        symbol.external?.address !== undefined
          ? symbol.external.address
          : typeof value === "function"
            ? functionPointer(value)
            : symbol.owner!.base + BigInt((value as WebAssembly.Global).value);
      if (address < 0n || address >= 1n << BigInt(memoryArena.address === "i32" ? 32 : 64))
        throw new RangeError("dynamic symbol address exceeds pointer width");
      global.value = word(address, memoryArena.address);
    }
    for (const record of fresh) {
      const relocate = record.instance!.exports.__wasm_apply_data_relocs;
      if (typeof relocate === "function") relocate();
    }
  } catch (error) {
    if (options.isControlFlow?.(error)) throw error;
    throw new DylinkInitializationError(error);
  }
  let initialized = false;
  return {
    order,
    layout: { ...layout, tableEnd: extra.tableEnd },
    instances: new Map(order.map((name) => [name, modules.get(name)!.instance!])),
    records: new Map(
      order.map((name) => {
        const record = modules.get(name)!;
        return [
          name,
          { instance: record.instance!, base: record.base, tableBase: record.tableBase },
        ];
      }),
    ),
    names: [...ownSymbols.keys()],
    /** Handle-local lookup excludes main/global preemption. Imports above still
     * honor that scope; explicit dlsym(handle, name) uses the object's own group. */
    lookup(name: string): DylinkExternalSymbol | undefined {
      const symbol = ownSymbols.get(name);
      if (!symbol) return undefined;
      const value = valueOf(symbol, name)!;
      const address =
        typeof value === "function"
          ? functionPointer(value)
          : symbol.owner!.base + BigInt((value as WebAssembly.Global).value);
      return { value, address, signature: signatureOf(symbol, name) };
    },
    initialize() {
      if (initialized) throw new Error("dynamic constructors cannot be retried");
      initialized = true;
      try {
        for (const record of fresh) {
          const ctor = record.instance!.exports.__wasm_call_ctors;
          if (typeof ctor === "function") ctor();
        }
      } catch (error) {
        if (options.isControlFlow?.(error)) throw error;
        throw new DylinkInitializationError(error);
      }
    },
  };
}
