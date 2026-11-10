// SPDX-License-Identifier: MIT

import { plan_dylink_layout, type DylinkArena } from "./dylink.ts";
import {
  read_wasm_dylink,
  read_wasm_dynamic_imports,
  read_wasm_dynamic_signatures,
  read_wasm_memories,
  dynamic_tail_table_import,
  prepare_wasm_dynamic_tail_calls,
  type WasmDylink,
} from "./wasm_binary.ts";
import { wasm_table_get } from "./wasm.ts";
import { create_dylink_forwarder } from "./dylink_forwarder.ts";

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

export type DylinkExternalTag = {
  value: WebAssembly.Tag;
  signature: string;
};

export type DylinkLazyFunction = {
  name: string;
  signature: string;
  target: WebAssembly.Global;
};

export type DylinkSymbolType = {
  kind: "function" | "global";
  signature?: string;
};

type Initialization = { state: "pending" | "running" | "done" | "failed" };
export type DylinkModuleRecord = {
  instance: WebAssembly.Instance;
  base: bigint;
  tableBase: bigint;
  initialization?: Initialization;
};

/** Link an already fetched batch in caller-owned process arenas.
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
  /** Process-private table used only by marked side-module tail calls. */
  tailTable?: WebAssembly.Table;
  /** Actual creation limits, which the JS reflection API does not expose. */
  memoryMaximumPages: bigint;
  tableMaximumElements?: bigint;
  stack: WebAssembly.Global;
  memoryArena: Readonly<DylinkArena>;
  tableArena: Readonly<DylinkArena>;
  hostFunctions?: ReadonlyMap<string, ReadonlyMap<string, CallableFunction>>;
  externalSymbols?: ReadonlyMap<string, DylinkExternalSymbol>;
  /** Main-module exception tags shared by dynamic objects. */
  externalTags?: ReadonlyMap<string, DylinkExternalTag>;
  /** Allow unresolved strong env function imports to remain callable through a
   * typed Wasm forwarder until a later global provider publishes its slot. */
  lazyFunctions?: boolean;
  /** Validate the prospective exported symbol view before process arenas change. */
  validateSymbols?(types: ReadonlyMap<string, DylinkSymbolType>): void;
  /** Ensure the shared table covers the completed layout after validation. */
  prepareTable?(minimum: bigint): void;
  reuse?: ReadonlyMap<string, DylinkModuleRecord>;
  functionPointers?: Map<CallableFunction, bigint>;
  /** Only the process profile which refuses Worker creation may use LLD's
   * first-thread TLS image. No imported/public TLS binding is provided. */
  initialThreadLocalTls?: boolean;
  /** Process-owned execution wrappers preserve the calling object's identity. */
  execution?: {
    prepare(name: string, bytes: Uint8Array<ArrayBuffer>): WebAssembly.Module;
    instantiate(name: string, action: () => WebAssembly.Instance): WebAssembly.Instance;
    register(name: string, instance: WebAssembly.Instance): void;
    callable(fn: CallableFunction): CallableFunction;
    tailCallable?(fn: CallableFunction): CallableFunction;
    settleTable(): void;
  };
  resolveDependency?(name: string, parent: string): string;
  /** Execution control transfers (exit/exec) must escape initialization intact. */
  isControlFlow?(error: unknown): boolean;
}) {
  const { memory, table, stack, memoryArena, tableArena } = options;
  const modules = new Map<
    string,
    {
      name: string;
      module: WebAssembly.Module;
      metadata: WasmDylink;
      imports: ReturnType<typeof read_wasm_dynamic_imports>;
      signatures: ReturnType<typeof read_wasm_dynamic_signatures>;
      exports: WebAssembly.ModuleExportDescriptor[];
      instance?: WebAssembly.Instance;
      base: bigint;
      tableBase: bigint;
      dependencies: string[];
      tailTableRequired: boolean;
      initialization: Initialization;
    }
  >();
  // An iterative DFS bounds traversal by fetched files, not the JavaScript stack.
  const order: string[] = [];
  const pending = [{ name: options.root, finish: false }];
  while (pending.length) {
    const { name, finish } = pending.pop()!;
    if (finish) {
      order.push(name);
      continue;
    }
    // Records are registered before following NEEDED edges. A back edge reuses
    // the same record; all instances and GOT bindings precede constructors.
    if (modules.has(name)) continue;
    const source = options.files.get(name);
    if (!source) throw new Error(`missing dynamic dependency: ${name}`);
    const tail = prepare_wasm_dynamic_tail_calls(source);
    const bytes = tail.bytes;
    if (tail.tailTableRequired && !options.tailTable)
      throw new Error("dynamic tail-call ABI table is unavailable");
    const originalModule = new WebAssembly.Module(bytes);
    const metadata = read_wasm_dylink(originalModule);
    if (!metadata) throw new Error(`missing dylink.0: ${name}`);
    if (metadata.unknownSubsections.length) throw new Error("unsupported dylink extension");
    const exports = WebAssembly.Module.exports(originalModule);
    const localTls = metadata.exports.filter((symbol) => symbol.flags & 0x100);
    if (
      metadata.imports.some((symbol) => symbol.flags & ~0xff) ||
      metadata.exports.some((symbol) => symbol.flags & ~0x1ff) ||
      (localTls.length &&
        (!options.initialThreadLocalTls ||
          localTls.some(
            (symbol) =>
              !(symbol.flags & 6) ||
              !exports.some((entry) => entry.name === symbol.name && entry.kind === "global"),
          ) ||
          ["__tls_base", "__tls_size", "__tls_align"].some(
            (name) => !exports.some((entry) => entry.name === name && entry.kind === "global"),
          )))
    )
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
    const resident = options.reuse?.get(name);
    modules.set(name, {
      name,
      module: resident
        ? originalModule
        : (options.execution?.prepare(name, bytes) ?? originalModule),
      metadata,
      imports: read_wasm_dynamic_imports(bytes),
      signatures: read_wasm_dynamic_signatures(bytes),
      exports,
      tailTableRequired: tail.tailTableRequired,
      base: 0n,
      tableBase: 0n,
      dependencies: metadata.needed.map(
        (dependency) => options.resolveDependency?.(dependency, name) ?? dependency,
      ),
      ...resident,
      initialization: resident?.initialization ?? { state: resident ? "done" : "pending" },
    });
    pending.push({ name, finish: true });
    for (const dependency of modules.get(name)!.dependencies.toReversed())
      pending.push({ name: dependency, finish: false });
  }
  const records = order.map((name) => modules.get(name)!);
  const fresh = records.filter((record) => !record.instance);
  type Record = (typeof records)[number];
  type Symbol = {
    owner?: Record;
    /** The actual provider export, which can differ from a public alias name. */
    name?: string;
    external?: DylinkExternalSymbol;
    kind: "function" | "global";
  };
  type Candidate = {
    owner: Record;
    name: string;
    kind: "function" | "global";
    reexport?: { module: string; name: string };
  };
  const symbols = new Map<string, Symbol>();
  for (const [name, external] of options.externalSymbols ?? []) {
    if (typeof external.value === "function") symbols.set(name, { external, kind: "function" });
    else if (external.value instanceof WebAssembly.Global && external.address !== undefined)
      symbols.set(name, { external, kind: "global" });
  }
  const externalSymbols = new Map(symbols);
  const ownSymbols = new Map<string, Symbol>();
  const functionPointers = options.functionPointers ?? new Map<CallableFunction, bigint>();
  const callable = (fn: CallableFunction) => {
    const wrapped = options.execution?.callable(fn) ?? fn;
    const address = functionPointers.get(fn) ?? functionPointers.get(wrapped);
    if (address !== undefined) {
      functionPointers.set(fn, address);
      functionPointers.set(wrapped, address);
    }
    return wrapped;
  };
  const valueOf = (symbol: Symbol, name: string) => {
    const value = symbol.owner?.instance?.exports[symbol.name ?? name] ?? symbol.external?.value;
    return typeof value === "function" ? callable(value) : value;
  };
  const signatureOf = (symbol: Symbol, name: string) =>
    symbol.owner?.signatures.exports.get(symbol.name ?? name) ?? symbol.external?.signature;
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
    "__tls_base",
    "__tls_size",
    "__tls_align",
    "__wasm_init_tls",
    "__wasm_apply_tls_relocs",
    "__wasm_apply_global_tls_relocs",
  ]);
  const candidates = new Map<string, Candidate[]>();
  const candidatesByRecord = new Map<Record, Map<string, Candidate>>();
  const reexports: Candidate[] = [];
  let objectFunctionCount = 0;
  for (const name of scope) {
    const record = modules.get(name)!;
    const flags = new Map(record.metadata.exports.map((symbol) => [symbol.name, symbol.flags]));
    for (const symbol of record.exports) {
      if (symbol.kind !== "function" && symbol.kind !== "global") continue;
      if (internal.has(symbol.name)) continue;
      const attributes = flags.get(symbol.name) ?? 0;
      if (attributes & 6) continue;
      if (symbol.kind === "function") objectFunctionCount++;
      const candidate: Candidate = {
        owner: record,
        name: symbol.name,
        kind: symbol.kind,
        ...(symbol.kind === "function"
          ? { reexport: record.signatures.reexports.get(symbol.name) }
          : {}),
      };
      const recordCandidates = candidatesByRecord.get(record) ?? new Map<string, Candidate>();
      recordCandidates.set(symbol.name, candidate);
      candidatesByRecord.set(record, recordCandidates);
      const group = candidates.get(symbol.name) ?? [];
      group.push(candidate);
      candidates.set(symbol.name, group);
      if (candidate.reexport) reexports.push(candidate);
    }
  }
  const resolveName = (name: string, visited: Set<Candidate>): Symbol | undefined => {
    const external = externalSymbols.get(name);
    if (external) return external;
    for (const candidate of candidates.get(name) ?? []) {
      if (visited.has(candidate)) continue;
      visited.add(candidate);
      if (!candidate.reexport)
        return { owner: candidate.owner, name: candidate.name, kind: candidate.kind };
      const target = resolveImport(candidate, visited);
      if (target) return target;
    }
    return undefined;
  };
  const resolveImport = (candidate: Candidate, visited: Set<Candidate>): Symbol | undefined => {
    const target = candidate.reexport!;
    // Public aliases need a canonical Wasm function slot for dlsym and GOT.func.
    // Host imports are callable from Wasm, but their JavaScript function values
    // cannot be installed in this process's Wasm function table.
    if (options.hostFunctions?.get(target.module)?.has(target.name))
      throw new Error(`unsupported dynamic re-export host import: ${target.module}.${target.name}`);
    if (target.module !== "env") return undefined;
    return resolveName(target.name, visited);
  };
  const aliasTargets = new Map<Candidate, Symbol>();
  // Normalize every public re-export before arena layout, clearing data, or
  // changing table entries. A missed provider or an alias-only cycle cannot
  // leave a partially initialized process resource behind.
  for (const alias of reexports) {
    const visited = new Set<Candidate>([alias]);
    const target = resolveImport(alias, visited);
    if (!target) throw new Error(`unresolved dynamic re-export: ${alias.owner.name}.${alias.name}`);
    if (target.external && typeof target.external.value === "function") {
      try {
        const probe = new WebAssembly.Table({ element: "anyfunc", initial: 1 });
        probe.set(0, target.external.value);
      } catch {
        throw new Error(
          `unsupported dynamic re-export host function: ${alias.owner.name}.${alias.name}`,
        );
      }
    }
    aliasTargets.set(alias, target);
  }
  for (const [name, group] of candidates) {
    if (!symbols.has(name)) {
      const resolved = resolveName(name, new Set());
      if (resolved) symbols.set(name, resolved);
    }
    const first = group[0]!;
    if (!ownSymbols.has(name))
      ownSymbols.set(
        name,
        aliasTargets.get(first) ?? {
          owner: first.owner,
          name: first.name,
          kind: first.kind,
        },
      );
  }
  const scopeFrom = (root: string) => {
    if (!modules.has(root)) throw new Error("unknown dynamic object");
    const names = [root],
      seen = new Set(names);
    for (let index = 0; index < names.length; index++)
      for (const name of modules.get(names[index]!)!.dependencies)
        if (!seen.has(name)) {
          seen.add(name);
          names.push(name);
        }
    return names;
  };
  const symbolsFrom = (root: string) => {
    if (root === options.root) return ownSymbols;
    const found = new Map<string, Symbol>();
    for (const name of scopeFrom(root)) {
      const record = modules.get(name)!;
      const recordCandidates = candidatesByRecord.get(record);
      for (const entry of record.exports) {
        if (
          (entry.kind === "function" || entry.kind === "global") &&
          !internal.has(entry.name) &&
          recordCandidates?.has(entry.name) &&
          !found.has(entry.name)
        ) {
          const candidate = recordCandidates!.get(entry.name)!;
          found.set(
            entry.name,
            aliasTargets.get(candidate) ?? {
              owner: record,
              name: entry.name,
              kind: entry.kind,
            },
          );
        }
      }
    }
    return found;
  };
  const symbolTypesFrom = (root: string): ReadonlyMap<string, DylinkSymbolType> => {
    const types = new Map<string, DylinkSymbolType>();
    for (const [name, localSymbol] of symbolsFrom(root)) {
      // The root's imports use the full process scope, where an already
      // published main/global symbol preempts a candidate in this batch.
      const symbol = root === options.root ? (symbols.get(name) ?? localSymbol) : localSymbol;
      const signature = symbol.kind === "function" ? signatureOf(symbol, name) : undefined;
      types.set(name, {
        kind: symbol.kind,
        ...(signature === undefined ? {} : { signature }),
      });
    }
    return types;
  };
  const functionGOT = new Set<string>();
  let requiredTableMinimum = 0n;
  for (const record of fresh) {
    const forwardedSignatures = new Map<string, string>();
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
          if (entry.minimum > requiredTableMinimum) requiredTableMinimum = entry.minimum;
          const privateTailTable =
            entry.module === "env" && entry.name === dynamic_tail_table_import;
          if (
            (privateTailTable
              ? !record.tailTableRequired
              : entry.module !== "env" || entry.name !== "__indirect_function_table") ||
            entry.address !== tableArena.address ||
            (options.tableMaximumElements !== undefined &&
              entry.minimum > options.tableMaximumElements) ||
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
          const unresolvedLazy =
            !!options.lazyFunctions && entry.module === "env" && !weak && !symbol;
          if (
            entry.module !== "env" ||
            (!weak && symbol?.kind !== "function" && !unresolvedLazy) ||
            (symbol && symbol.kind !== "function")
          )
            throw new Error(`unresolved dynamic function: ${entry.module}.${entry.name}`);
          const importSignature = record.signatures.imports.find(
            (item) =>
              item.module === entry.module &&
              item.name === entry.name &&
              item.typeIndex === entry.typeIndex,
          )!.signature;
          if (symbol && signatureOf(symbol, entry.name) !== importSignature)
            throw new Error(`dynamic function signature mismatch: ${entry.name}`);
          if (!symbol) {
            const previous = forwardedSignatures.get(entry.name);
            if (previous !== undefined && previous !== importSignature)
              throw new Error(`conflicting unresolved dynamic function signatures: ${entry.name}`);
            forwardedSignatures.set(entry.name, importSignature);
          }
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
          break;
        case "tag": {
          if (entry.module !== "env")
            throw new Error(`unsupported dynamic tag import: ${entry.module}.${entry.name}`);
          const provider = options.externalTags?.get(entry.name);
          const signature = record.signatures.tagImports.find(
            (item) =>
              item.module === entry.module &&
              item.name === entry.name &&
              item.typeIndex === entry.typeIndex,
          )?.signature;
          if (
            !provider ||
            typeof WebAssembly.Tag !== "function" ||
            !(provider.value instanceof WebAssembly.Tag)
          )
            throw new Error(`unresolved dynamic tag: ${entry.module}.${entry.name}`);
          if (signature === undefined || provider.signature !== signature)
            throw new Error(`dynamic tag signature mismatch: ${entry.name}`);
          break;
        }
      }
    }
  }
  if (
    memoryArena.cursor < 1n ||
    tableArena.cursor < 1n ||
    options.memoryMaximumPages * 65536n < BigInt(memory.buffer.byteLength) ||
    (options.tableMaximumElements !== undefined &&
      options.tableMaximumElements < BigInt(table.length)) ||
    memoryArena.limit > BigInt(memory.buffer.byteLength)
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
        tableSize: functionGOT.size + objectFunctionCount,
        tableAlignment: 0,
      },
    ],
    { ...memoryArena, cursor: layout.memoryEnd },
    { ...tableArena, cursor: layout.tableEnd },
  );
  options.validateSymbols?.(symbolTypesFrom(options.root));
  const requiredTableCapacity =
    extra.tableEnd > requiredTableMinimum ? extra.tableEnd : requiredTableMinimum;
  options.prepareTable?.(requiredTableCapacity);
  if (requiredTableMinimum > BigInt(table.length))
    throw new Error("incompatible dynamic table import");
  if (options.tailTable && BigInt(options.tailTable.length) !== BigInt(table.length))
    throw new Error("dynamic canonical and tail tables have different sizes");
  if (options.tailTable && requiredTableCapacity > BigInt(options.tailTable.length))
    throw new Error("incompatible dynamic tail table import");
  if (tableArena.limit > BigInt(table.length))
    throw new RangeError("dynamic table arena must already belong to committed process resources");
  for (const [index, record] of fresh.entries()) Object.assign(record, layout.items[index]);
  const word = (value: bigint, type: "i32" | "i64") => (type === "i64" ? value : Number(value));
  const got: { entry: { module: string; name: string }; global: WebAssembly.Global }[] = [];
  const lazyFunctions: DylinkLazyFunction[] = [];
  const forwards = new Map<Record, { providerName: string; target: WebAssembly.Global }[]>();
  let nextSlot = layout.tableEnd;
  function functionPointer(fn: CallableFunction): bigint {
    const wrapped = callable(fn);
    const old = functionPointers.get(wrapped);
    if (old !== undefined) return old;
    for (const record of records)
      for (
        let index = record.tableBase;
        index < record.tableBase + BigInt(record.metadata.tableSize);
        index++
      ) {
        const value = wasm_table_get(table, word(index, tableArena.address));
        if (value === wrapped || (value && callable(value) === wrapped)) {
          if (options.tailTable) {
            const tail = options.execution?.tailCallable?.(fn) ?? wrapped;
            const set = options.tailTable.set as unknown as (
              index: number | bigint,
              value: CallableFunction,
            ) => void;
            set.call(options.tailTable, word(index, tableArena.address), tail);
          }
          functionPointers.set(fn, index);
          functionPointers.set(wrapped, index);
          return index;
        }
      }
    const index = nextSlot++;
    if (index >= extra.tableEnd) throw new RangeError("dynamic function slot budget exhausted");
    const set = table.set as unknown as (index: number | bigint, value: CallableFunction) => void;
    const address = word(index, tableArena.address);
    set.call(table, address, wrapped);
    if (options.tailTable) {
      const tail = options.execution?.tailCallable?.(fn) ?? wrapped;
      const tailSet = options.tailTable.set as unknown as (
        index: number | bigint,
        value: CallableFunction,
      ) => void;
      tailSet.call(options.tailTable, address, tail);
    }
    functionPointers.set(fn, index);
    functionPointers.set(wrapped, index);
    return index;
  }
  try {
    const set = table.set as unknown as (index: number | bigint, value: null) => void;
    const tailSet = options.tailTable?.set as
      | ((index: number | bigint, value: null) => void)
      | undefined;
    for (let index = tableArena.cursor; index < extra.tableEnd; index++) {
      const address = word(index, tableArena.address);
      set.call(table, address, null);
      tailSet?.call(options.tailTable!, address, null);
    }
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
            group[entry.name] =
              entry.module === "env" && entry.name === dynamic_tail_table_import
                ? options.tailTable!
                : table;
            break;
          case "function": {
            const host = options.hostFunctions?.get(entry.module)?.get(entry.name);
            const definition = symbols.get(entry.name);
            const dependency = definition && valueOf(definition, entry.name);
            if (host || typeof dependency === "function") {
              group[entry.name] = host ?? dependency!;
            } else {
              const signature = record.signatures.imports.find(
                (item) =>
                  item.module === entry.module &&
                  item.name === entry.name &&
                  item.typeIndex === entry.typeIndex,
              )!.signature;
              const forward = create_dylink_forwarder(signature, table, tableArena.address);
              group[entry.name] = forward.call;
              const attributes = record.metadata.imports.find(
                (item) => item.module === entry.module && item.name === entry.name,
              );
              const weak = !!(attributes && attributes.flags & 1);
              if (options.lazyFunctions && entry.module === "env" && !weak && !definition)
                lazyFunctions.push({ name: entry.name, signature, target: forward.target });
              if (definition) {
                const provider = definition.owner;
                if (!provider) throw new Error("unavailable dynamic function");
                const pending = forwards.get(provider) ?? [];
                pending.push({
                  providerName: definition.name ?? entry.name,
                  target: forward.target,
                });
                forwards.set(provider, pending);
              }
              // A weak undefined call retains target zero and traps natively.
            }
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
            break;
          case "tag": {
            const provider = options.externalTags!.get(entry.name)!;
            // The current TypeScript WebAssembly.Imports type predates tag imports.
            Object.assign(group, { [entry.name]: provider.value });
            break;
          }
        }
      }
      const instantiate = () => new WebAssembly.Instance(record.module, imports);
      record.instance = options.execution
        ? options.execution.instantiate(record.name, instantiate)
        : instantiate();
      options.execution?.register(record.name, record.instance);
      options.execution?.settleTable();
      // Publish each provider immediately, as the previous late JS lookup did.
      // A later start section can call an earlier module through this edge.
      for (const { providerName, target } of forwards.get(record) ?? []) {
        const fn = record.instance.exports[providerName];
        if (typeof fn !== "function") throw new Error("unavailable dynamic function");
        target.value = word(functionPointer(fn), tableArena.address);
      }
      forwards.delete(record);
    }
    if (forwards.size) throw new Error("unavailable dynamic function provider");
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
    // LLD initializes the first thread's private TLS image in the module's
    // allocated data region. Never re-run __wasm_init_tls on resident reuse or
    // publish these globals as ordinary process-wide data addresses.
    for (const record of fresh) {
      const localTls = record.metadata.exports.filter((symbol) => symbol.flags & 0x100);
      if (!localTls.length) continue;
      const value = (name: string) => {
        const global = record.instance!.exports[name];
        if (
          !(global instanceof WebAssembly.Global) ||
          typeof global.value !== (memoryArena.address === "i64" ? "bigint" : "number")
        )
          throw new Error("incompatible initial TLS layout");
        return BigInt.asUintN(memoryArena.address === "i64" ? 64 : 32, BigInt(global.value));
      };
      const base = value("__tls_base"),
        size = value("__tls_size"),
        align = value("__tls_align");
      if (
        size <= 0n ||
        align <= 0n ||
        align & (align - 1n) ||
        base % align ||
        base < record.base ||
        base + size > record.base + BigInt(record.metadata.memorySize) ||
        localTls.some((symbol) => value(symbol.name) < 0n || value(symbol.name) > size)
      )
        throw new Error("initial TLS image is outside its module data");
    }
    for (const record of fresh) {
      const relocations = ["__wasm_apply_data_relocs"];
      if (options.initialThreadLocalTls)
        relocations.push("__wasm_apply_tls_relocs", "__wasm_apply_global_tls_relocs");
      for (const name of relocations) {
        const relocate = record.instance!.exports[name];
        if (typeof relocate === "function") {
          callable(relocate)();
          options.execution?.settleTable();
        }
      }
    }
  } catch (error) {
    if (options.isControlFlow?.(error)) throw error;
    throw new DylinkInitializationError(error);
  }
  let initialized = false;
  const ensureInitializedFrom = (root: string) => {
    try {
      const reachable = new Set(scopeFrom(root));
      for (const name of order) {
        if (!reachable.has(name)) continue;
        const record = modules.get(name)!;
        const initialization = record.initialization;
        if (initialization.state === "failed")
          throw new Error("dynamic constructor previously failed");
        if (initialization.state !== "pending") continue;
        initialization.state = "running";
        try {
          const ctor = record.instance!.exports.__wasm_call_ctors;
          if (typeof ctor === "function") {
            callable(ctor)();
            options.execution?.settleTable();
          }
          initialization.state = "done";
        } catch (error) {
          initialization.state = "failed";
          throw error;
        }
      }
    } catch (error) {
      if (options.isControlFlow?.(error)) throw error;
      throw error instanceof DylinkInitializationError
        ? error
        : new DylinkInitializationError(error);
    }
  };
  const ensureInitialized = () => ensureInitializedFrom(options.root);
  const lookupSymbol = (
    symbol: Symbol | undefined,
    name: string,
  ): DylinkExternalSymbol | undefined => {
    if (!symbol) return undefined;
    const value = valueOf(symbol, name)!;
    const address =
      typeof value === "function"
        ? functionPointer(value)
        : symbol.owner!.base + BigInt((value as WebAssembly.Global).value);
    return { value, address, signature: signatureOf(symbol, name) };
  };
  const lookupFrom = (root: string, name: string) =>
    lookupSymbol(symbolsFrom(root).get(name), name);
  const lookupOwn = (root: string, name: string) => {
    const record = modules.get(root);
    if (!record) throw new Error("unknown dynamic object");
    const entry = record.exports.find((entry) => entry.name === name);
    if (
      !entry ||
      (entry.kind !== "function" && entry.kind !== "global") ||
      internal.has(name) ||
      record.metadata.exports.some((entry) => entry.name === name && entry.flags & 0x106)
    )
      return undefined;
    const candidate = candidatesByRecord.get(record)?.get(name);
    if (!candidate) return undefined;
    return lookupSymbol(
      aliasTargets.get(candidate) ?? { owner: record, name, kind: entry.kind },
      name,
    );
  };
  return {
    order,
    layout: { ...layout, tableEnd: extra.tableEnd },
    instances: new Map(order.map((name) => [name, modules.get(name)!.instance!])),
    records: new Map(
      order.map((name) => {
        const record = modules.get(name)!;
        return [
          name,
          {
            instance: record.instance!,
            base: record.base,
            tableBase: record.tableBase,
            initialization: record.initialization,
          },
        ];
      }),
    ),
    names: [...ownSymbols.keys()],
    /** Handle-local lookup excludes main/global preemption. Imports above still
     * honor that scope; explicit dlsym(handle, name) uses the object's own group. */
    lookup(name: string): DylinkExternalSymbol | undefined {
      return lookupFrom(options.root, name);
    },
    lookupFrom,
    lookupOwn,
    symbolNamesFrom: (root: string) => [...symbolsFrom(root).keys()],
    symbolTypesFrom,
    lazyFunctions: Object.freeze(lazyFunctions),
    initialize() {
      if (initialized) throw new Error("dynamic constructors cannot be retried");
      initialized = true;
      ensureInitialized();
    },
    /** Reentrant dlopen may encounter a shared dependency before its outer
     * initializer reaches it. Running/done modules are skipped, failed ones
     * stay poisoned; a fresh traversal never retries a constructor. */
    ensureInitialized,
    ensureInitializedFrom,
  };
}
