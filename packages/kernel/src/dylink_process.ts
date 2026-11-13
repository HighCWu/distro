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
import {
  DylinkWorkerModuleError,
  inspect_dylink_worker_empty_tls_scaffold,
  type DylinkWorkerEmptyTlsScaffold,
} from "./dylink_worker_module.ts";
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
import {
  apply_dylink_worker_publication,
  clone_trusted_dylink_worker_snapshot,
  prepare_dylink_worker_snapshot,
  validate_dylink_worker_snapshot,
  validate_dylink_worker_replayable_module,
  DylinkWorkerSnapshotError,
  type DylinkWorkerPublication,
  type DylinkWorkerSnapshot,
  type DylinkWorkerSymbol,
  type DylinkWorkerTableSlot,
} from "./dylink_process_worker.ts";
import { DylinkWorkerPublicationAbort } from "./dylink_worker_abort.ts";

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
type ReplayGroupState = {
  group: Group;
  root: string;
  externalSymbols: Map<string, DylinkExternalSymbol>;
};
export type DylinkWorkerPublicationState = {
  readonly processIdentity: string;
  readonly generation: number;
  readonly snapshot: DylinkWorkerSnapshot;
};
type WorkerPublicationState = DylinkWorkerPublicationState;
type WorkerPublicationAdvanceContext = {
  baseState: WorkerPublicationState | null;
  baseRevision: number;
  snapshot: DylinkWorkerSnapshot;
  targetSnapshot: DylinkWorkerSnapshot | null;
  snapshotRevision: number;
  advanced: boolean;
};
export interface DylinkWorkerOwnerRollback {
  /** Restore ProcessDylink's owner graph after all receivers have aborted. */
  restore(): void;
  /** Free allocations and release pins after restore while peers may resume. */
  release(): void;
  /** Discard rollback state at the Finalize handoff before constructors. */
  commit(): void;
}
type WorkerPublicationTableUndo = {
  canonical: CallableFunction | null;
  tail?: CallableFunction | null;
};
type WorkerPublicationSymbolUndo = {
  hadAddress: boolean;
  address?: bigint;
};
type WorkerPublicationOwnerRollbackSnapshot = {
  symbols: Map<string, DylinkExternalSymbol>;
  pointers: Map<CallableFunction, bigint>;
  files: Map<string, File>;
  aliases: Map<string, string>;
  reuse: Map<string, DylinkModuleRecord>;
  groups: Map<string, ObjectHandle>;
  replayGroups: ReplayGroupState[];
  addressNames: Map<string, bigint>;
  handles: Map<bigint, ObjectHandle>;
  globalOrder: string[];
  owners: Map<string, number>;
  ownerNames: Map<number, string>;
  functions: Map<
    CallableFunction,
    { owner: number | null; addressOwner?: number; signature?: string }
  >;
  wrappers: Map<CallableFunction, CallableFunction>;
  tailWrappers: Map<CallableFunction, CallableFunction>;
  originals: Map<CallableFunction, CallableFunction>;
  lazyFunctions: DylinkLazyFunction[];
  mainHandle: bigint;
  lastMap: bigint;
  lastMapBytes: Uint8Array<ArrayBuffer> | null;
  cursor: bigint;
  nextOwner: number;
  tailTable: WebAssembly.Table | null;
  error: string;
  workerPublicationState: WorkerPublicationState | null;
  workerPublicationRevision: number;
  workerGraphRevision: number;
};
type WorkerPublicationOwnerRollbackState = {
  phase: "open" | "restored" | "releasing" | "released" | "committed";
  snapshot: WorkerPublicationOwnerRollbackSnapshot | null;
  readonly tableUndo: Map<bigint, WorkerPublicationTableUndo>;
  readonly symbolUndo: Map<DylinkExternalSymbol, WorkerPublicationSymbolUndo>;
  readonly lazyGlobalUndo: Map<WebAssembly.Global, number | bigint>;
  readonly persistentAllocations: WasmAddress[];
  readonly pins: number[];
  token: DylinkWorkerOwnerRollback;
};
type WorkerPublicationOpenScope = {
  processIdentity: string;
  baseGeneration: number;
  baseState: WorkerPublicationState;
  baseRevision: number;
  authorizationPending: boolean;
  advanced: boolean;
  reopened: boolean;
  rollback: WorkerPublicationOwnerRollbackState;
};
type WorkerExtensionStage = {
  files: Map<string, File>;
  groups: ReplayGroupState[];
  objects: Map<string, ObjectHandle>;
  handles: Map<bigint, ObjectHandle>;
  reuse: Map<string, DylinkModuleRecord>;
  instances: Map<string, WebAssembly.Instance>;
  symbols: Map<string, DylinkExternalSymbol>;
  aliases: Map<string, string>;
  globalOrder: string[];
  owners: Map<string, number>;
  ownerNames: Map<number, string>;
  nextOwner: number;
  addressNames: Map<string, bigint>;
  functions: Map<
    CallableFunction,
    { owner: number | null; addressOwner?: number; signature?: string }
  >;
  wrappers: Map<CallableFunction, CallableFunction>;
  tailWrappers: Map<CallableFunction, CallableFunction>;
  originals: Map<CallableFunction, CallableFunction>;
  pointers: Map<CallableFunction, bigint>;
  lazyFunctions: DylinkLazyFunction[];
  lazyWrites: { target: WebAssembly.Global; previous: number | bigint; next: WasmAddress }[];
  tableWrites: Map<bigint, { value: CallableFunction | null; tailValue?: CallableFunction | null }>;
  tailTable?: WebAssembly.Table;
  installsTailTable: boolean;
  nextSnapshot: DylinkWorkerSnapshot;
  nextGeneration: number;
};
type WorkerExtensionCandidateData = {
  process: ProcessDylink;
  revision: number;
  priorState: WorkerPublicationState;
  stage: WorkerExtensionStage;
};
type WorkerExtensionTableValue = {
  index: bigint;
  canonical: CallableFunction | null;
  tail?: CallableFunction | null;
  nextCanonical: CallableFunction | null;
  nextTail?: CallableFunction | null;
};
type WorkerExtensionMapChange = { map: Map<any, any>; key: any; value: any };
type WorkerExtensionReceiptData = {
  process: ProcessDylink;
  priorState: WorkerPublicationState;
  nextState: WorkerPublicationState;
  priorRevision: number;
  committedRevision: number;
  priorPublicationRevision: number;
  priorGroupLength: number;
  committedGroupLength: number;
  priorGlobalLength: number;
  committedGlobalLength: number;
  priorLazyFunctions: DylinkLazyFunction[];
  priorTailTable: WebAssembly.Table | null;
  committedTailTable: WebAssembly.Table | null;
  priorMainHandle: bigint;
  priorLastMap: bigint;
  priorCursor: bigint;
  priorNextOwner: number;
  priorError: string;
  mapChanges: WorkerExtensionMapChange[];
  tableValues: WorkerExtensionTableValue[];
  lazyWrites: WorkerExtensionStage["lazyWrites"];
};
const workerExtensionCandidates = new WeakMap<object, WorkerExtensionCandidateData>();
const workerExtensionReceipts = new WeakMap<object, WorkerExtensionReceiptData>();
/** Opaque candidate returned by prepareWorkerExtension for a later barrier commit. */
export type DylinkWorkerExtensionCandidate = object;
/** Opaque provisional commit token. Finalize or roll it back exactly once. */
export type DylinkWorkerExtensionReceipt = object;
type SnapshotExportIndex = Map<unknown, Map<string, string[]>>;

function sameWorkerSnapshotValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left instanceof Uint8Array || right instanceof Uint8Array) {
    if (
      !(left instanceof Uint8Array) ||
      !(right instanceof Uint8Array) ||
      left.length !== right.length
    )
      return false;
    for (let index = 0; index < left.length; index++)
      if (left[index] !== right[index]) return false;
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => sameWorkerSnapshotValue(value, right[index]));
  }
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null)
    return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key) =>
      Object.hasOwn(right, key) &&
      sameWorkerSnapshotValue(
        (left as Record<string, unknown>)[key],
        (right as Record<string, unknown>)[key],
      ),
  );
}

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
  replay?: DylinkWorkerSnapshot;
  workerPublicationState?: WorkerPublicationState;
  /** Internal publication barrier run after a new group is registered and before
   * any constructor executes. The snapshot is detached and validated. */
  beforeInitialize?(
    snapshot: DylinkWorkerSnapshot,
    ownerRollback?: DylinkWorkerOwnerRollback,
  ): void;
  /** Whether this open needs a Worker publication snapshot and barrier. */
  beforeInitializeActive?(): boolean;
  blocked(): boolean;
  queryBlocked?(): boolean;
  postThread?(): boolean;
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
 * Worker snapshots reconstruct modules without replaying process initialization. */
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
  readonly #replayGroups: ReplayGroupState[] = [];
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
  #workerPublicationState: WorkerPublicationState | null = null;
  #workerPublicationRevision = 0;
  #workerGraphRevision = 0;
  #workerExtensionReceipt: DylinkWorkerExtensionReceipt | null = null;
  #workerPublicationAdvanceContext: WorkerPublicationAdvanceContext | null = null;
  #workerPublicationOpenScope: WorkerPublicationOpenScope | null = null;

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
    if (options.replay) this.#restoreWorkerSnapshot(options.replay);
    if (options.workerPublicationState) {
      const state = options.workerPublicationState;
      if (
        !options.replay ||
        state.snapshot !== options.replay ||
        typeof state.processIdentity !== "string" ||
        state.processIdentity.length === 0 ||
        !Number.isSafeInteger(state.generation) ||
        state.generation < 0
      )
        throw new DylinkWorkerSnapshotError(
          "EINVAL",
          "dynamic Worker publication state does not match its validated replay snapshot",
        );
      validate_dylink_worker_snapshot(state.snapshot);
      this.#workerPublicationState = Object.freeze({ ...state });
      this.#workerPublicationRevision = this.#workerGraphRevision;
    }
  }
  #owner(name: string) {
    const existing = this.#owners.get(name);
    if (existing !== undefined) return existing;
    if (this.#nextOwner > 0xffffffff) throw new RangeError("dynamic caller capacity exhausted");
    const owner = this.#nextOwner++;
    this.#owners.set(name, owner);
    this.#ownerNames.set(owner, name);
    this.#touchWorkerGraph();
    return owner;
  }
  #touchWorkerGraph() {
    if (this.#workerGraphRevision >= Number.MAX_SAFE_INTEGER)
      throw new RangeError("dynamic Worker graph revision exhausted");
    this.#workerGraphRevision++;
  }
  #workerExtensionPendingFailure() {
    if (!this.#workerExtensionReceipt) return false;
    this.#error = "dynamic graph publication is awaiting acknowledgement";
    return true;
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
        this.#touchWorkerGraph();
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
        const currentTail = tailTable ? wasm_table_get(tailTable, address) : null;
        if (tailTable && currentTail !== null) {
          this.#rememberWorkerPublicationTableUndo(index, fn, currentTail);
          tailSet!.call(tailTable, address, null);
        }
        continue;
      }
      const wrapped = this.#callable(fn);
      const tailWrapped = tailTable ? this.#tailCallable(fn) : undefined;
      const currentTail = tailTable ? wasm_table_get(tailTable, address) : null;
      const pointer = this.#pointers.get(fn) ?? this.#pointers.get(wrapped) ?? index;
      const pointerChanged =
        this.#pointers.get(fn) !== pointer || this.#pointers.get(wrapped) !== pointer;
      this.#pointers.set(fn, pointer);
      this.#pointers.set(wrapped, pointer);
      if (pointerChanged) this.#touchWorkerGraph();
      if (wrapped !== fn || (tailTable && tailWrapped && currentTail !== tailWrapped))
        this.#rememberWorkerPublicationTableUndo(index, fn, currentTail);
      if (wrapped !== fn) set.call(this.#table, address, wrapped);
      if (tailTable && tailWrapped && currentTail !== tailWrapped)
        tailSet!.call(tailTable, address, tailWrapped);
    }
  }
  #moduleExports(moduleKey: string): Record<string, unknown> | undefined {
    if (moduleKey === "main") return this.#options.main.exports;
    return this.#reuse.get(moduleKey)?.instance.exports;
  }
  #moduleHint(value: unknown): string | undefined {
    if (typeof value !== "function") return undefined;
    const raw = this.#originals.get(value) ?? value;
    const info = this.#functions.get(raw) ?? this.#functions.get(value);
    const owner = info?.addressOwner ?? info?.owner;
    if (owner === 0) return "main";
    return owner === undefined || owner === null ? undefined : this.#ownerNames.get(owner);
  }
  #buildSnapshotExportIndex(): SnapshotExportIndex {
    const index: SnapshotExportIndex = new Map();
    const add = (moduleKey: string, name: string, value: unknown) => {
      let identity: unknown;
      if (typeof value === "function") identity = this.#originals.get(value) ?? value;
      else if (value instanceof WebAssembly.Global) identity = value;
      else if (typeof WebAssembly.Tag === "function" && value instanceof WebAssembly.Tag)
        identity = value;
      else return;

      let modules = index.get(identity);
      if (!modules) index.set(identity, (modules = new Map()));
      let aliases = modules.get(moduleKey);
      if (!aliases) modules.set(moduleKey, (aliases = []));
      aliases.push(name);
    };
    const addModule = (moduleKey: string, exports: Record<string, unknown>) => {
      for (const [name, value] of Object.entries(exports)) add(moduleKey, name, value);
    };

    addModule("main", this.#options.main.exports);
    for (const moduleKey of this.#files.keys()) {
      const exports = this.#moduleExports(moduleKey);
      if (exports) addModule(moduleKey, exports);
    }
    for (const modules of index.values()) for (const aliases of modules.values()) aliases.sort();
    return index;
  }
  #findExport(
    value: unknown,
    kind: "function" | "global" | "tag",
    preferredName: string | undefined,
    index: SnapshotExportIndex,
  ) {
    const raw = typeof value === "function" ? (this.#originals.get(value) ?? value) : value;
    const modules = index.get(kind === "function" ? raw : value);
    if (!modules) return undefined;
    const hintedModule = this.#moduleHint(value);
    const foundIn = (moduleKey: string) => {
      const aliases = modules.get(moduleKey);
      if (!aliases?.length) return undefined;
      const exportAlias =
        preferredName && aliases.includes(preferredName) ? preferredName : aliases[0]!;
      return { moduleKey, exportAlias };
    };
    if (hintedModule) {
      const hinted = foundIn(hintedModule);
      if (hinted) return hinted;
    }
    const main = hintedModule === "main" ? undefined : foundIn("main");
    if (main) return main;
    // The index's module map was populated in main-then-file order, so only
    // modules that actually export this identity need to be considered here.
    for (const [moduleKey] of modules) {
      if (moduleKey === "main" || moduleKey === hintedModule) continue;
      const found = foundIn(moduleKey);
      if (found) return found;
    }
    return undefined;
  }
  #describeSymbol(
    name: string,
    symbol: DylinkExternalSymbol,
    index: SnapshotExportIndex,
  ): DylinkWorkerSymbol {
    const kind = typeof symbol.value === "function" ? "function" : "global";
    const found = this.#findExport(symbol.value, kind, name, index);
    if (!found)
      throw new DylinkWorkerSnapshotError(
        "EOPNOTSUPP",
        `dynamic symbol ${name} has no export that can be rebound in a Worker`,
      );
    const signature =
      symbol.signature ??
      (typeof symbol.value === "function"
        ? (
            this.#functions.get(this.#originals.get(symbol.value) ?? symbol.value) ??
            this.#functions.get(symbol.value)
          )?.signature
        : undefined);
    if (kind === "function" && signature === undefined)
      throw new DylinkWorkerSnapshotError(
        "EOPNOTSUPP",
        `dynamic function ${name} has no recorded signature`,
      );
    const controlGlobal = found.moduleKey === "main" && mainControlGlobals.has(found.exportAlias);
    return {
      ...found,
      kind,
      ...(signature === undefined ? {} : { signature }),
      ...(controlGlobal || symbol.address === undefined ? {} : { address: symbol.address }),
    };
  }
  #describeTableSlot(fn: CallableFunction, index: SnapshotExportIndex): DylinkWorkerTableSlot {
    const found = this.#findExport(fn, "function", undefined, index);
    if (!found)
      throw new DylinkWorkerSnapshotError(
        "EOPNOTSUPP",
        "an occupied dynamic table slot has no rebindable module export",
      );
    return found;
  }
  #resolveWorkerExport(moduleKey: string, exportAlias: string): unknown {
    return this.#moduleExports(moduleKey)?.[exportAlias];
  }
  #restoreWorkerSymbol(
    [name, descriptor]: readonly [string, DylinkWorkerSymbol],
    resolve: (moduleKey: string, exportAlias: string) => unknown = (moduleKey, exportAlias) =>
      this.#resolveWorkerExport(moduleKey, exportAlias),
  ): DylinkExternalSymbol {
    const value = resolve(descriptor.moduleKey, descriptor.exportAlias);
    if (descriptor.kind === "function") {
      if (typeof value !== "function")
        throw new DylinkWorkerSnapshotError(
          "EINVAL",
          `Worker replay is missing function export ${descriptor.moduleKey}.${descriptor.exportAlias}`,
        );
      return {
        value,
        ...(descriptor.signature === undefined ? {} : { signature: descriptor.signature }),
        ...(descriptor.address === undefined ? {} : { address: descriptor.address }),
      };
    }
    if (descriptor.kind === "global") {
      if (!(value instanceof WebAssembly.Global))
        throw new DylinkWorkerSnapshotError(
          "EINVAL",
          `Worker replay is missing global export ${descriptor.moduleKey}.${descriptor.exportAlias}`,
        );
      return {
        value,
        ...(descriptor.address === undefined ? {} : { address: descriptor.address }),
      };
    }
    throw new DylinkWorkerSnapshotError(
      "EOPNOTSUPP",
      `dynamic tag ${name} cannot be rebound through the current process symbol table`,
    );
  }
  exportWorkerSnapshot(): DylinkWorkerSnapshot {
    if (this.#workerExtensionPendingFailure())
      throw new DylinkWorkerSnapshotError("EOPNOTSUPP", "Worker graph publication is provisional");
    try {
      return this.#buildWorkerSnapshot();
    } catch (error) {
      if (error instanceof DylinkWorkerSnapshotError) throw error;
      if (error instanceof RangeError)
        throw new DylinkWorkerSnapshotError("ENOMEM", "cannot build dynamic Worker snapshot", {
          cause: error,
        });
      throw error;
    }
  }
  initializeWorkerPublication(processIdentity: string): DylinkWorkerPublicationState {
    if (typeof processIdentity !== "string" || processIdentity.length === 0)
      throw new DylinkWorkerSnapshotError("EINVAL", "Worker publication identity is empty");

    const existing = this.#workerPublicationState;
    if (existing) {
      if (existing.processIdentity !== processIdentity)
        throw new DylinkWorkerSnapshotError(
          "EINVAL",
          "Worker publication identity does not match the established process",
        );
      if (this.#workerGraphRevision !== this.#workerPublicationRevision)
        throw new DylinkWorkerSnapshotError(
          "EINVAL",
          "Worker publication baseline is stale after a process graph change",
        );
      return this.#copyWorkerPublicationState(existing);
    }

    // A baseline must be established before any thread can clone this loader.
    // exportWorkerSnapshot retains the normal idle/vfork/active-caller checks.
    if (this.#options.postThread?.())
      throw new DylinkWorkerSnapshotError(
        "EOPNOTSUPP",
        "Worker publication baseline must be initialized before thread creation",
      );
    const snapshot = this.exportWorkerSnapshot();
    const state = Object.freeze({ processIdentity, generation: 0, snapshot });
    this.#workerPublicationState = state;
    this.#workerPublicationRevision = this.#workerGraphRevision;
    return this.#copyWorkerPublicationState(state);
  }
  /** @internal Record a failure originating in the Worker publication coordinator. */
  recordWorkerPublicationFailure(error: unknown, message?: string): WasmAddress {
    if (this.#options.isControlFlow(error) || error instanceof DylinkInitializationError)
      return this.#failure(error);
    return this.#failure(message === undefined ? error : new Error(message, { cause: error }));
  }
  /** Discard a pre-thread publication baseline after a failed clone attempt.
   * The live loader graph is left untouched; a later initialization takes a
   * fresh snapshot under a new process identity. */
  discardWorkerPublicationBeforeThreads(): void {
    if (this.#options.postThread?.())
      throw new DylinkWorkerSnapshotError(
        "EOPNOTSUPP",
        "Worker publication cannot be discarded after thread creation",
      );
    if (this.#busy || this.#addressBusy || this.#caller.value !== 0 || this.#workerExtensionReceipt)
      throw new DylinkWorkerSnapshotError(
        "EOPNOTSUPP",
        "Worker publication cannot be discarded while dynamic loader state is active",
      );

    const state = this.#workerPublicationState;
    if (state && state.generation !== 0)
      throw new DylinkWorkerSnapshotError(
        "EOPNOTSUPP",
        "Worker publication cannot be discarded after a graph generation was published",
      );

    this.#workerPublicationState = null;
    this.#workerPublicationRevision = 0;
  }
  getWorkerPublicationState(): DylinkWorkerPublicationState | null {
    const state = this.#workerPublicationState;
    if (!state) return null;
    if (this.#workerGraphRevision !== this.#workerPublicationRevision)
      throw new DylinkWorkerSnapshotError(
        "EINVAL",
        `Worker publication baseline is stale after a process graph change (${this.#workerPublicationRevision}/${this.#workerGraphRevision})`,
      );
    return this.#copyWorkerPublicationState(state);
  }
  /** Run trusted runtime bookkeeping while guest Wasm is stopped at a
   * cooperative checkpoint. The callback must not invoke guest code or the
   * guest allocator. A provisional Worker receipt is intentionally allowed:
   * a later checkpoint may need to finalize or roll it back. */
  runAtWorkerCheckpoint<T>(action: () => T): T {
    if (typeof action !== "function")
      throw new TypeError("Worker checkpoint action must be callable");
    if (
      this.#busy ||
      this.#addressBusy ||
      this.#workerPublicationOpenScope !== null ||
      this.#workerPublicationAdvanceContext !== null ||
      (this.#options.queryBlocked?.() ?? false)
    )
      throw new DylinkWorkerSnapshotError(
        "EOPNOTSUPP",
        "Worker checkpoint is unavailable during loader or vfork activity",
      );

    const previousCaller = this.#caller.value;
    this.#caller.value = 0;
    try {
      return action();
    } finally {
      this.#caller.value = previousCaller;
    }
  }
  /** Advance the owner after every Worker accepted the graph published by the
   * current beforeInitialize hook. This updates only the publication baseline;
   * the live loader graph, instances and tables are already committed locally. */
  advanceWorkerPublicationBeforeInitialize(
    processIdentity: string,
    baseGeneration: number,
    snapshot: DylinkWorkerSnapshot,
  ): DylinkWorkerPublicationState {
    const context = this.#workerPublicationAdvanceContext;
    if (!context || context.advanced || context.snapshot !== snapshot)
      throw new DylinkWorkerSnapshotError(
        "EINVAL",
        "Worker publication can only advance once for the current initialization hook",
      );
    const baseState = context.baseState;
    const openScope = this.#workerPublicationOpenScope;
    if (
      !baseState ||
      this.#workerPublicationState !== baseState ||
      baseState.processIdentity !== processIdentity ||
      baseState.generation !== baseGeneration ||
      !Number.isSafeInteger(baseGeneration) ||
      baseGeneration < 0 ||
      baseGeneration >= Number.MAX_SAFE_INTEGER ||
      context.baseRevision !== this.#workerPublicationRevision ||
      (openScope &&
        (openScope.baseState !== baseState ||
          openScope.processIdentity !== processIdentity ||
          openScope.baseGeneration !== baseGeneration ||
          openScope.baseRevision !== context.baseRevision ||
          openScope.advanced))
    )
      throw new DylinkWorkerSnapshotError(
        "EINVAL",
        "Worker publication identity, generation, or starting baseline is stale",
      );
    if (
      this.#busy ||
      this.#addressBusy ||
      this.#caller.value !== 0 ||
      this.#workerExtensionReceipt ||
      this.#workerGraphRevision !== context.snapshotRevision
    )
      throw new DylinkWorkerSnapshotError(
        "EOPNOTSUPP",
        "Worker publication target changed or loader became active before baseline advancement",
      );

    const targetSnapshot = context.targetSnapshot;
    if (!targetSnapshot || this.#workerGraphRevision !== context.snapshotRevision)
      throw new DylinkWorkerSnapshotError(
        "EINVAL",
        "Worker publication graph changed or has no captured target snapshot",
      );
    if (!sameWorkerSnapshotValue(snapshot, targetSnapshot))
      throw new DylinkWorkerSnapshotError(
        "EINVAL",
        "Worker publication snapshot was changed after the linked graph was captured",
      );

    const nextState: WorkerPublicationState = Object.freeze({
      processIdentity,
      generation: baseGeneration + 1,
      snapshot: targetSnapshot,
    });
    this.#validateAppendOnlyWorkerSlots(baseState.snapshot, targetSnapshot);
    const result = this.#copyWorkerPublicationState(nextState);
    this.#workerPublicationState = nextState;
    this.#workerPublicationRevision = context.snapshotRevision;
    context.advanced = true;
    if (openScope) openScope.advanced = true;
    return result;
  }
  #validateAppendOnlyWorkerSlots(base: DylinkWorkerSnapshot, target: DylinkWorkerSnapshot): void {
    if (
      target.main.tableSlots.length < base.main.tableSlots.length ||
      target.groups.length < base.groups.length
    )
      throw new DylinkWorkerSnapshotError(
        "EINVAL",
        "Worker publication removes existing graph slots",
      );

    const requireExistingPairs = (
      previous: readonly (readonly [string, unknown])[],
      current: readonly (readonly [string, unknown])[],
      label: string,
    ) => {
      const currentByName = new Map(current);
      for (const [name, value] of previous) {
        if (!currentByName.has(name) || !sameWorkerSnapshotValue(value, currentByName.get(name)))
          throw new DylinkWorkerSnapshotError(
            "EINVAL",
            `Worker publication changes existing ${label} ${name}`,
          );
      }
    };

    for (let index = 0; index < base.main.tableSlots.length; index++) {
      const previous = base.main.tableSlots[index];
      if (previous !== null && !sameWorkerSnapshotValue(previous, target.main.tableSlots[index]))
        throw new DylinkWorkerSnapshotError(
          "EINVAL",
          `Worker publication changes existing table slot ${index}`,
        );
    }
    requireExistingPairs(base.main.functionSlots, target.main.functionSlots, "main function slot");

    for (let index = 0; index < base.groups.length; index++) {
      const previous = base.groups[index]!;
      const current = target.groups[index];
      if (
        !current ||
        previous.id !== current.id ||
        previous.root !== current.root ||
        previous.handle !== current.handle
      )
        throw new DylinkWorkerSnapshotError(
          "EINVAL",
          `Worker publication replaces existing group ${index}`,
        );
      const currentSlots = new Map(current.functionSlots);
      for (const [key, oldSlots] of previous.functionSlots) {
        const newSlots = currentSlots.get(key);
        if (!newSlots)
          throw new DylinkWorkerSnapshotError(
            "EINVAL",
            `Worker publication removes function slots for ${key}`,
          );
        requireExistingPairs(oldSlots, newSlots, `${key} function slot`);
      }
    }
  }
  #copyWorkerPublicationState(state: WorkerPublicationState): DylinkWorkerPublicationState {
    try {
      return Object.freeze({
        processIdentity: state.processIdentity,
        generation: state.generation,
        snapshot: clone_trusted_dylink_worker_snapshot(state.snapshot),
      });
    } catch (error) {
      if (error instanceof DylinkWorkerSnapshotError) throw error;
      if (error instanceof RangeError)
        throw new DylinkWorkerSnapshotError("ENOMEM", "cannot copy Worker publication state", {
          cause: error,
        });
      throw error;
    }
  }
  #buildWorkerSnapshot(): DylinkWorkerSnapshot {
    const publicationScopeActive =
      !!this.#workerPublicationOpenScope && !this.#workerPublicationOpenScope.authorizationPending;
    const queryBlocked =
      this.#options.queryBlocked?.() ?? (!publicationScopeActive && this.#options.blocked());
    if (
      this.#workerExtensionReceipt ||
      this.#busy ||
      this.#addressBusy ||
      this.#caller.value !== 0 ||
      queryBlocked ||
      (!publicationScopeActive && this.#options.blocked())
    )
      throw new DylinkWorkerSnapshotError(
        "EOPNOTSUPP",
        "dynamic loader state cannot be snapshotted while active",
      );

    for (const state of this.#replayGroups) {
      for (const key of state.group.order) {
        const file = this.#files.get(key);
        const instance = state.group.instances.get(key);
        if (!file || !instance)
          throw new DylinkWorkerSnapshotError(
            "EINVAL",
            `dynamic module ${key} is missing while snapshotting`,
          );

        let emptyTlsScaffold: DylinkWorkerEmptyTlsScaffold | null;
        try {
          emptyTlsScaffold = inspect_dylink_worker_empty_tls_scaffold(
            file.bytes,
            this.#options.address,
            file.module,
          );
        } catch (error) {
          if (error instanceof DylinkWorkerModuleError)
            throw new DylinkWorkerSnapshotError(
              "EOPNOTSUPP",
              `dynamic module ${key} has unsupported TLS scaffolding`,
              { cause: error },
            );
          throw error;
        }
        if (!emptyTlsScaffold) continue;

        const base = instance.exports.__tls_base;
        const initialBase = this.#options.address === "i64" ? 0n : 0;
        if (!(base instanceof WebAssembly.Global) || base.value !== initialBase)
          throw new DylinkWorkerSnapshotError(
            "EOPNOTSUPP",
            `dynamic module ${key} changed its empty TLS base before Worker replay`,
          );
      }
    }

    this.#reservePublishedFunctionSlots();
    const exportIndex = this.#buildSnapshotExportIndex();

    const tableSlots: (DylinkWorkerTableSlot | null)[] = [];
    const mainFunctionSlots = new Map<string, bigint>();
    for (let index = 0n; index < BigInt(this.#table.length); index++) {
      const fn = wasm_table_get(this.#table, this.#word(index, this.#options.tableType.address));
      if (!fn) {
        tableSlots.push(null);
        continue;
      }
      const descriptor = this.#describeTableSlot(fn, exportIndex);
      tableSlots.push(descriptor);
      if (descriptor.moduleKey === "main") {
        const current = mainFunctionSlots.get(descriptor.exportAlias);
        if (current === undefined) mainFunctionSlots.set(descriptor.exportAlias, index);
      }
    }
    for (const [name, value] of Object.entries(this.#options.main.exports)) {
      if (typeof value !== "function") continue;
      const pointer =
        this.#pointers.get(value) ?? this.#pointers.get(this.#originals.get(value) ?? value);
      if (pointer !== undefined && !mainFunctionSlots.has(name))
        mainFunctionSlots.set(name, pointer);
    }

    const groups = this.#replayGroups.map((state, id) => {
      const placements: [string, { base: bigint; tableBase: bigint }][] = [];
      const functionSlots: [string, [string, bigint][]][] = [];
      for (const key of state.group.order) {
        const record = state.group.records.get(key);
        const file = this.#files.get(key);
        const instance = state.group.instances.get(key);
        if (!record || !file || !instance)
          throw new DylinkWorkerSnapshotError("EINVAL", `dynamic group ${key} is incomplete`);
        placements.push([key, { base: record.base, tableBase: record.tableBase }]);
        const slots: [string, bigint][] = [];
        for (const entry of WebAssembly.Module.exports(file.module)) {
          if (entry.kind !== "function") continue;
          const value = instance.exports[entry.name];
          if (typeof value !== "function") continue;
          const raw = this.#originals.get(value) ?? value;
          const symbol = state.group.lookupOwn(key, entry.name);
          const pointer = this.#pointers.get(value) ?? this.#pointers.get(raw) ?? symbol?.address;
          if (pointer !== undefined) slots.push([entry.name, pointer]);
        }
        functionSlots.push([key, slots]);
      }
      const externalSymbols = [...state.externalSymbols].map(
        ([name, symbol]) => [name, this.#describeSymbol(name, symbol, exportIndex)] as const,
      );
      const handle = this.#groups.get(state.root)?.handle;
      if (handle === undefined)
        throw new DylinkWorkerSnapshotError(
          "EINVAL",
          `dynamic group root ${state.root} has no handle`,
        );
      return {
        id,
        root: state.root,
        handle,
        order: [...state.group.order],
        lazyFunctions: state.group.lazyFunctions.map(
          ({ name, signature }) => [name, signature] as const,
        ),
        placements,
        functionSlots,
        externalSymbols,
      };
    });
    const groupIds = new Map(this.#replayGroups.map((state, index) => [state.group, index]));
    const objectGroups = [...this.#groups].map(([key, object]) => {
      const groupId = groupIds.get(object.group);
      const state = groupId === undefined ? undefined : this.#replayGroups[groupId];
      if (groupId === undefined || !state)
        throw new DylinkWorkerSnapshotError("EINVAL", `dynamic object ${key} has no replay group`);
      return [key, { groupId, root: state.root, handle: object.handle }] as const;
    });
    const files = [...this.#files.values()].map((file) => ({
      key: file.key,
      path: file.path,
      bytes: file.bytes,
      pin: file.pin,
      ...(file.handle === undefined ? {} : { handle: file.handle }),
      dependencies: [...file.dependencies],
    }));
    const symbols = [...this.#symbols].map(
      ([name, symbol]) => [name, this.#describeSymbol(name, symbol, exportIndex)] as const,
    );
    // A snapshot may be the first operation that needs to expose the main
    // object handle in another Worker. Allocate it once while this loader is
    // still the single owner, so replayed and parent processes share the same
    // stable link_map instead of lazily allocating one per Worker.
    if (!this.#mainHandle) this.#mainHandle = this.#linkMap("", 0n);
    const snapshot: DylinkWorkerSnapshot = {
      version: 1,
      address: this.#options.address,
      tableAddress: this.#options.tableType.address,
      main: {
        handle: this.#mainHandle,
        lastMap: this.#lastMap,
        cursor: this.#cursor,
        tableLength: tableSlots.length,
        functionSlots: [...mainFunctionSlots],
        tableSlots,
        addressNames: [...this.#addressNames],
      },
      files,
      groups,
      objectGroups,
      aliases: [...this.#aliases],
      globalOrder: [...this.#globalOrder],
      owners: [...this.#owners],
      ownerNames: [...this.#ownerNames],
      nextOwner: this.#nextOwner,
      symbols,
    };
    try {
      return prepare_dylink_worker_snapshot(snapshot);
    } catch (error) {
      if (error instanceof DylinkWorkerSnapshotError) throw error;
      if (error instanceof RangeError)
        throw new DylinkWorkerSnapshotError("ENOMEM", "cannot copy dynamic Worker snapshot", {
          cause: error,
        });
      throw error;
    }
  }
  #restoreWorkerSnapshot(snapshot: DylinkWorkerSnapshot) {
    try {
      this.#restoreWorkerSnapshotContents(snapshot);
    } catch (error) {
      if (error instanceof DylinkWorkerSnapshotError) throw error;
      if (error instanceof RangeError)
        throw new DylinkWorkerSnapshotError("ENOMEM", "cannot restore dynamic Worker snapshot", {
          cause: error,
        });
      throw error;
    }
  }
  #restoreWorkerSnapshotContents(snapshot: DylinkWorkerSnapshot) {
    validate_dylink_worker_snapshot(snapshot);
    if (
      snapshot.address !== this.#options.address ||
      snapshot.tableAddress !== this.#options.tableType.address
    )
      throw new DylinkWorkerSnapshotError(
        "EINVAL",
        "dynamic Worker snapshot ABI does not match this instance",
      );
    if (BigInt(this.#table.length) > BigInt(snapshot.main.tableLength))
      throw new DylinkWorkerSnapshotError(
        "EINVAL",
        "dynamic Worker table is larger than its snapshot",
      );

    const preparedFiles = new Map<string, File>();
    let tailTableRequired = false;
    for (const source of snapshot.files) {
      let module: WebAssembly.Module;
      try {
        module = new WebAssembly.Module(source.bytes);
      } catch (error) {
        if (error instanceof WebAssembly.CompileError)
          throw new DylinkWorkerSnapshotError(
            "EOPNOTSUPP",
            `dynamic module ${source.key} cannot be compiled by this Worker`,
            { cause: error },
          );
        if (error instanceof RangeError)
          throw new DylinkWorkerSnapshotError(
            "ENOMEM",
            `cannot compile dynamic module ${source.key}`,
            { cause: error },
          );
        throw error;
      }
      const metadata = read_wasm_dylink(module);
      if (!metadata)
        throw new DylinkWorkerSnapshotError(
          "EINVAL",
          `dynamic module ${source.key} has no dylink metadata`,
        );
      tailTableRequired ||= prepare_wasm_dynamic_tail_calls(source.bytes).tailTableRequired;
      preparedFiles.set(source.key, {
        pin: source.pin,
        key: source.key,
        path: source.path,
        bytes: source.bytes,
        module,
        metadata,
        dependencies: new Map(source.dependencies),
        ...(source.handle === undefined ? {} : { handle: source.handle }),
      });
    }

    if (tailTableRequired) this.#ensureTailTable();
    if (BigInt(snapshot.main.tableLength) > BigInt(this.#table.length)) {
      try {
        this.#grow(BigInt(snapshot.main.tableLength));
      } catch (error) {
        if (error instanceof RangeError)
          throw new DylinkWorkerSnapshotError("ENOMEM", "cannot grow Worker function table", {
            cause: error,
          });
        throw error;
      }
    }
    if (BigInt(this.#table.length) !== BigInt(snapshot.main.tableLength))
      throw new DylinkWorkerSnapshotError(
        "EINVAL",
        "Worker function table length does not match snapshot",
      );

    for (const [name, owner] of snapshot.owners) this.#owners.set(name, owner);
    for (const [owner, name] of snapshot.ownerNames) this.#ownerNames.set(owner, name);
    this.#nextOwner = snapshot.nextOwner;
    for (const [key, file] of preparedFiles) this.#files.set(key, file);

    this.#pointers.clear();
    for (const [name, slot] of snapshot.main.functionSlots) {
      const value = this.#options.main.exports[name];
      if (typeof value !== "function")
        throw new DylinkWorkerSnapshotError(
          "EINVAL",
          `main function export ${name} is unavailable`,
        );
      const wrapped = this.#callable(value);
      const known = this.#pointers.get(value) ?? this.#pointers.get(wrapped);
      if (known !== undefined && known !== slot)
        throw new DylinkWorkerSnapshotError("EINVAL", `main function slot conflicts for ${name}`);
      this.#pointers.set(value, slot);
      this.#pointers.set(wrapped, slot);
    }
    const tableSet = this.#table.set as unknown as (
      index: WasmAddress,
      value: CallableFunction | null,
    ) => void;
    const tailSet = this.#tailTable?.set as
      | ((index: WasmAddress, value: CallableFunction | null) => void)
      | undefined;
    for (let index = 0; index < snapshot.main.tableSlots.length; index++) {
      const entry = snapshot.main.tableSlots[index];
      if (!entry || entry.moduleKey !== "main") continue;
      const value = this.#resolveWorkerExport("main", entry.exportAlias);
      if (typeof value !== "function")
        throw new DylinkWorkerSnapshotError(
          "EINVAL",
          `main table export ${entry.exportAlias} is unavailable`,
        );
      const address = this.#word(BigInt(index), this.#options.tableType.address);
      tableSet.call(this.#table, address, this.#callable(value));
      if (this.#tailTable) tailSet!.call(this.#tailTable, address, this.#tailCallable(value));
    }

    const bytes = new Map(snapshot.files.map((file) => [file.key, file.bytes]));
    const replayedGroups: Group[] = [];
    const tableAliasesByModule = new Map<string, [number, string][]>();
    for (const [index, entry] of snapshot.main.tableSlots.entries()) {
      if (!entry) continue;
      const aliases = tableAliasesByModule.get(entry.moduleKey) ?? [];
      aliases.push([index, entry.exportAlias]);
      tableAliasesByModule.set(entry.moduleKey, aliases);
    }
    for (const sourceGroup of snapshot.groups) {
      const externalSymbols = new Map<string, DylinkExternalSymbol>();
      for (const entry of sourceGroup.externalSymbols)
        externalSymbols.set(entry[0], this.#restoreWorkerSymbol(entry));
      const functionMetadata = new Map<
        string,
        ReadonlyMap<string, { signature: string; imported: boolean }>
      >();
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
      const setReplayFunctionPointer = (fn: CallableFunction, slot: bigint, verify: boolean) => {
        const raw = this.#originals.get(fn) ?? fn;
        const wrapped = this.#callable(fn);
        const known = this.#pointers.get(raw) ?? this.#pointers.get(wrapped);
        if (verify && known !== undefined && known !== slot)
          throw new DylinkWorkerSnapshotError(
            "EINVAL",
            "replayed function slot conflicts with the snapshot",
          );
        if (known === undefined || verify) {
          this.#pointers.set(raw, slot);
          this.#pointers.set(wrapped, slot);
        }
      };
      let group: Group;
      try {
        group = link_dylink_graph({
          root: sourceGroup.root,
          files: bytes,
          memory: this.#options.memory,
          table: this.#table,
          tailTable: this.#tailTable ?? undefined,
          stack: this.#stack,
          memoryMaximumPages: BigInt(this.#options.maximumPages),
          tableMaximumElements: this.#options.tableType.maximum,
          memoryArena: {
            cursor: 1n,
            limit: BigInt(this.#options.memory.buffer.byteLength),
            address: this.#options.address,
          },
          tableArena: {
            cursor: 1n,
            limit: BigInt(this.#table.length),
            address: this.#options.tableType.address,
          },
          hostFunctions,
          hostGlobals,
          externalSymbols,
          externalTags: this.#tags,
          functionPointers: this.#pointers,
          lazyFunctions: sourceGroup.lazyFunctions.length > 0,
          replay: {
            placements: new Map(sourceGroup.placements),
            functionSlots: new Map(
              sourceGroup.functionSlots.map(([key, slots]) => [key, new Map(slots)] as const),
            ),
          },
          reuse: this.#reuse,
          resolveDependency: (name, parent) => {
            const key = this.#files.get(parent)?.dependencies.get(name);
            if (!key)
              throw new DylinkWorkerSnapshotError(
                "EINVAL",
                `snapshot lacks dependency ${parent} -> ${name}`,
              );
            return key;
          },
          isControlFlow: this.#options.isControlFlow,
          execution: {
            prepare: (name, sourceBytes) => {
              const prepared = prepare_dylink_call_metadata(sourceBytes);
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
            register: (name, instance) => {
              this.#registerFunctions(this.#owner(name), instance, functionMetadata.get(name)!);
              const functionSlots =
                sourceGroup.functionSlots.find(([key]) => key === name)?.[1] ?? [];
              for (const [alias, slot] of functionSlots) {
                const fn = instance.exports[alias];
                if (typeof fn !== "function")
                  throw new DylinkWorkerSnapshotError(
                    "EINVAL",
                    `replay function export ${name}.${alias} is missing`,
                  );
                setReplayFunctionPointer(fn, slot, true);
              }
              for (const [index, alias] of tableAliasesByModule.get(name) ?? []) {
                const fn = instance.exports[alias];
                if (typeof fn !== "function")
                  throw new DylinkWorkerSnapshotError(
                    "EINVAL",
                    `replay table export ${name}.${alias} is missing`,
                  );
                setReplayFunctionPointer(fn, BigInt(index), false);
              }
            },
            callable: (fn) => this.#callable(fn),
            tailCallable: (fn) => this.#tailCallable(fn),
            // Start, relocation and constructor code are absent in replay.
            // Defer wrapping until the exact saved table image is restored.
            settleTable: () => {},
          },
        });
      } catch (error) {
        if (this.#options.isControlFlow(error)) throw error;
        if (error instanceof WebAssembly.CompileError || error instanceof WebAssembly.LinkError)
          throw new DylinkWorkerSnapshotError(
            "EOPNOTSUPP",
            "dynamic module replay is unsupported",
            { cause: error },
          );
        if (error instanceof RangeError)
          throw new DylinkWorkerSnapshotError(
            "ENOMEM",
            "dynamic module replay exhausted Worker resources",
            { cause: error },
          );
        if (error instanceof DylinkWorkerSnapshotError) throw error;
        throw new DylinkWorkerSnapshotError(
          "EINVAL",
          "dynamic module snapshot could not be replayed",
          { cause: error },
        );
      }
      replayedGroups.push(group);
      this.#replayGroups.push({
        group,
        root: sourceGroup.root,
        externalSymbols,
      });
      for (const pending of group.lazyFunctions) this.#lazyFunctions.push(pending);
      for (const [key, record] of group.records) this.#reuse.set(key, record);
    }

    for (const [key, file] of this.#files) {
      const object = snapshot.objectGroups.find(([objectKey]) => objectKey === key)?.[1];
      if (!object)
        throw new DylinkWorkerSnapshotError("EINVAL", `snapshot has no object handle for ${key}`);
      const group = replayedGroups[object.groupId];
      if (!group)
        throw new DylinkWorkerSnapshotError(
          "EINVAL",
          `snapshot group ${object.groupId} is unavailable`,
        );
      file.handle = object.handle;
      const loaded = { group, root: key, handle: object.handle };
      this.#groups.set(key, loaded);
      this.#handles.set(object.handle, loaded);
    }
    this.#symbols.clear();
    for (const [name, symbol] of snapshot.symbols)
      this.#symbols.set(name, this.#restoreWorkerSymbol([name, symbol]));
    for (const [alias, key] of snapshot.aliases) this.#aliases.set(alias, key);
    this.#globalOrder.push(...snapshot.globalOrder);
    for (const [name, address] of snapshot.main.addressNames) this.#addressNames.set(name, address);
    this.#mainHandle = snapshot.main.handle;
    this.#lastMap = snapshot.main.lastMap;
    this.#cursor = snapshot.main.cursor;
    this.#bindLazyFunctions();

    for (let index = 0; index < snapshot.main.tableSlots.length; index++) {
      const entry = snapshot.main.tableSlots[index];
      const address = this.#word(BigInt(index), this.#options.tableType.address);
      if (!entry) {
        tableSet.call(this.#table, address, null);
        tailSet?.call(this.#tailTable!, address, null);
        continue;
      }
      const value = this.#resolveWorkerExport(entry.moduleKey, entry.exportAlias);
      if (typeof value !== "function")
        throw new DylinkWorkerSnapshotError(
          "EINVAL",
          `Worker replay is missing table function ${entry.moduleKey}.${entry.exportAlias}`,
        );
      tableSet.call(this.#table, address, this.#callable(value));
      if (this.#tailTable) tailSet!.call(this.#tailTable, address, this.#tailCallable(value));
    }
    this.#settleTable();
  }
  /** Prepare new Worker instances for one append-only graph publication. This
   * method never publishes functions, symbols, handles or groups. The only
   * visible capacity change allowed here is an empty table grow. */
  prepareWorkerExtension(input: DylinkWorkerPublication): DylinkWorkerExtensionCandidate {
    if (this.#workerExtensionPendingFailure())
      throw new DylinkWorkerSnapshotError(
        "EOPNOTSUPP",
        "another Worker graph publication is provisional",
      );
    const priorState = this.#workerPublicationState;
    if (!priorState)
      throw new DylinkWorkerSnapshotError(
        "EOPNOTSUPP",
        "this ProcessDylink instance has no validated Worker publication state",
      );
    if (this.#busy || this.#addressBusy || this.#caller.value !== 0)
      throw new DylinkWorkerSnapshotError(
        "EOPNOTSUPP",
        "dynamic Worker extension requires an idle loader",
      );
    if (this.#workerGraphRevision !== this.#workerPublicationRevision)
      throw new DylinkWorkerSnapshotError(
        "EINVAL",
        "Worker graph changed after its last validated publication",
      );

    const revision = this.#workerGraphRevision;
    let applied: ReturnType<typeof apply_dylink_worker_publication>;
    try {
      applied = apply_dylink_worker_publication(
        priorState.snapshot,
        priorState.processIdentity,
        priorState.generation,
        input,
      );
    } catch (error) {
      if (error instanceof DylinkWorkerSnapshotError) throw error;
      if (error instanceof RangeError)
        throw new DylinkWorkerSnapshotError("ENOMEM", "cannot validate Worker graph extension", {
          cause: error,
        });
      throw error;
    }

    const base = priorState.snapshot;
    const nextSnapshot = applied.snapshot;
    if (
      nextSnapshot.main.handle !== this.#mainHandle ||
      base.main.handle !== this.#mainHandle ||
      base.main.lastMap !== this.#lastMap ||
      base.main.cursor !== this.#cursor ||
      base.files.length !== this.#files.size ||
      base.groups.length !== this.#replayGroups.length ||
      base.objectGroups.length !== this.#groups.size ||
      base.aliases.length !== this.#aliases.size ||
      base.symbols.length !== this.#symbols.size ||
      base.globalOrder.length !== this.#globalOrder.length ||
      base.owners.length !== this.#owners.size ||
      base.ownerNames.length !== this.#ownerNames.size ||
      base.main.addressNames.length !== this.#addressNames.size ||
      BigInt(this.#table.length) < BigInt(base.main.tableLength)
    )
      throw new DylinkWorkerSnapshotError(
        "EINVAL",
        "Worker publication base is stale for this process",
      );
    if (nextSnapshot.main.tableLength < base.main.tableLength)
      throw new DylinkWorkerSnapshotError(
        "EINVAL",
        "Worker publication shrinks the function table",
      );

    const stage: WorkerExtensionStage = {
      files: new Map(),
      groups: [],
      objects: new Map(),
      handles: new Map(),
      reuse: new Map(),
      instances: new Map(),
      symbols: new Map(),
      aliases: new Map(nextSnapshot.aliases.slice(base.aliases.length)),
      globalOrder: [...nextSnapshot.globalOrder.slice(base.globalOrder.length)],
      owners: new Map(nextSnapshot.owners.slice(base.owners.length)),
      ownerNames: new Map(nextSnapshot.ownerNames.slice(base.ownerNames.length)),
      nextOwner: nextSnapshot.nextOwner,
      addressNames: new Map(nextSnapshot.main.addressNames.slice(base.main.addressNames.length)),
      functions: new Map(),
      wrappers: new Map(),
      tailWrappers: new Map(),
      originals: new Map(),
      pointers: new Map(),
      lazyFunctions: [],
      lazyWrites: [],
      tableWrites: new Map(),
      tailTable: this.#tailTable ?? undefined,
      installsTailTable: false,
      nextSnapshot,
      nextGeneration: applied.generation,
    };

    const stageOwners = new Map(this.#owners);
    for (const [name, owner] of nextSnapshot.owners) stageOwners.set(name, owner);
    const stageInstances = stage.instances;
    for (const [key, record] of this.#reuse) stageInstances.set(key, record.instance);

    const resolveExport = (moduleKey: string, exportAlias: string): unknown =>
      moduleKey === "main"
        ? this.#options.main.exports[exportAlias]
        : (stageInstances.get(moduleKey)?.exports[exportAlias] ??
          this.#moduleExports(moduleKey)?.[exportAlias]);

    const stageCallable = (fn: CallableFunction): CallableFunction => {
      const raw = stage.originals.get(fn) ?? this.#originals.get(fn) ?? fn;
      const info =
        stage.functions.get(raw) ??
        stage.functions.get(fn) ??
        this.#functions.get(raw) ??
        this.#functions.get(fn);
      if (!info || info.owner === null || !info.signature) return fn;
      const existing = stage.wrappers.get(raw) ?? this.#wrappers.get(raw);
      if (existing) return existing;
      const wrapped = create_dylink_call_wrapper(info.signature, raw, this.#caller, info.owner);
      stage.wrappers.set(raw, wrapped);
      stage.wrappers.set(wrapped, wrapped);
      stage.originals.set(wrapped, raw);
      stage.functions.set(wrapped, info);
      const pointer =
        stage.pointers.get(raw) ??
        stage.pointers.get(fn) ??
        this.#pointers.get(raw) ??
        this.#pointers.get(fn);
      if (pointer !== undefined) {
        stage.pointers.set(raw, pointer);
        stage.pointers.set(wrapped, pointer);
      }
      return wrapped;
    };
    const stageTailCallable = (fn: CallableFunction): CallableFunction => {
      const raw = stage.originals.get(fn) ?? this.#originals.get(fn) ?? fn;
      const info =
        stage.functions.get(raw) ??
        stage.functions.get(fn) ??
        this.#functions.get(raw) ??
        this.#functions.get(fn);
      if (!info || info.owner === null || !info.signature) return raw;
      const existing = stage.tailWrappers.get(raw) ?? this.#tailWrappers.get(raw);
      if (existing) return existing;
      const wrapped = create_dylink_tail_call_wrapper(
        info.signature,
        raw,
        this.#caller,
        info.owner,
      );
      stage.tailWrappers.set(raw, wrapped);
      stage.tailWrappers.set(wrapped, wrapped);
      return wrapped;
    };
    const setStagePointer = (fn: CallableFunction, pointer: bigint) => {
      const raw = stage.originals.get(fn) ?? this.#originals.get(fn) ?? fn;
      const wrapped = stageCallable(fn);
      for (const value of [raw, fn, wrapped]) {
        const current = stage.pointers.get(value) ?? this.#pointers.get(value);
        if (current !== undefined && current !== pointer)
          throw new DylinkWorkerSnapshotError(
            "EINVAL",
            "Worker extension changes an existing function slot",
          );
        stage.pointers.set(value, pointer);
      }
    };

    // Compile only new source objects. Existing modules and instances are reused
    // by the linker and never instantiated a second time.
    for (const source of nextSnapshot.files.slice(base.files.length)) {
      let module: WebAssembly.Module;
      try {
        module = new WebAssembly.Module(source.bytes);
      } catch (error) {
        if (error instanceof RangeError)
          throw new DylinkWorkerSnapshotError(
            "ENOMEM",
            `cannot compile extension module ${source.key}`,
            { cause: error },
          );
        if (error instanceof WebAssembly.CompileError)
          throw new DylinkWorkerSnapshotError(
            "EOPNOTSUPP",
            `extension module ${source.key} cannot be compiled`,
            { cause: error },
          );
        throw error;
      }
      const metadata = read_wasm_dylink(module);
      if (!metadata)
        throw new DylinkWorkerSnapshotError(
          "EINVAL",
          `extension module ${source.key} has no dylink metadata`,
        );
      const file: File = {
        pin: source.pin,
        key: source.key,
        path: source.path,
        bytes: source.bytes,
        module,
        metadata,
        dependencies: new Map(source.dependencies),
        ...(source.handle === undefined ? {} : { handle: source.handle }),
      };
      stage.files.set(file.key, file);
    }

    const filesByKey = new Map(this.#files);
    for (const [key, file] of stage.files) filesByKey.set(key, file);
    const fileBytes = new Map<string, Uint8Array<ArrayBuffer>>(
      [...filesByKey].map(([key, file]) => [key, file.bytes]),
    );
    const replayReuse = new Map(this.#reuse);
    let needsTailTable = false;
    for (const file of stage.files.values())
      needsTailTable ||= prepare_wasm_dynamic_tail_calls(file.bytes).tailTableRequired;

    // Capacity-only growth is allowed at prepare time; all occupied table
    // entries remain unchanged until commit.
    if (BigInt(nextSnapshot.main.tableLength) > BigInt(this.#table.length)) {
      try {
        this.#grow(BigInt(nextSnapshot.main.tableLength));
      } catch (error) {
        if (error instanceof RangeError)
          throw new DylinkWorkerSnapshotError(
            "ENOMEM",
            "cannot reserve Worker function table capacity",
            { cause: error },
          );
        throw error;
      }
    }
    if (BigInt(this.#table.length) < BigInt(nextSnapshot.main.tableLength))
      throw new DylinkWorkerSnapshotError(
        "EINVAL",
        "Worker function table did not reach the requested capacity",
      );

    const createTailTable = () => {
      const address = this.#options.tableType.address;
      const initial = BigInt(this.#table.length);
      const maximum = this.#options.tableType.maximum;
      const descriptor = {
        element: "anyfunc",
        address,
        initial: address === "i64" ? initial : Number(initial),
        ...(maximum === undefined
          ? {}
          : { maximum: address === "i64" ? maximum : Number(maximum) }),
      } as unknown as WebAssembly.TableDescriptor;
      const table = new WebAssembly.Table(descriptor);
      if (BigInt(table.length) !== initial)
        throw new DylinkWorkerSnapshotError("EINVAL", "cannot create extension tail table");
      return table;
    };
    if (needsTailTable && !stage.tailTable) {
      stage.tailTable = createTailTable();
      stage.installsTailTable = true;
      const set = stage.tailTable.set as unknown as (
        index: WasmAddress,
        fn: CallableFunction | null,
      ) => void;
      for (let index = 3n; index < BigInt(this.#table.length); index++) {
        const fn = wasm_table_get(this.#table, this.#word(index, this.#options.tableType.address));
        if (fn)
          set.call(
            stage.tailTable,
            this.#word(index, this.#options.tableType.address),
            stageTailCallable(fn),
          );
      }
    }

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

    const addWrite = (
      index: bigint,
      value: CallableFunction | null,
      tailValue?: CallableFunction | null,
    ) => {
      if (index < 0n || index >= BigInt(nextSnapshot.main.tableLength))
        throw new DylinkWorkerSnapshotError(
          "EINVAL",
          "Worker extension writes outside the published table",
        );
      if (index < base.main.cursor) {
        const old = stage.tableWrites.get(index);
        if (old && old.value === value) return;
        throw new DylinkWorkerSnapshotError(
          "EINVAL",
          "Worker extension attempts to rewrite a prior table slot",
        );
      }
      const previous = stage.tableWrites.get(index);
      if (previous) {
        if (previous.value === null && value !== null) {
          stage.tableWrites.set(index, {
            value,
            ...(stage.tailTable ? { tailValue: tailValue ?? null } : {}),
          });
          return;
        }
        if (previous.value !== value || previous.tailValue !== tailValue)
          throw new DylinkWorkerSnapshotError(
            "EINVAL",
            "Worker extension has conflicting staged table writes",
          );
      }
      stage.tableWrites.set(index, {
        value,
        ...(stage.tailTable ? { tailValue: tailValue ?? null } : {}),
      });
    };

    const newGroups = nextSnapshot.groups.slice(base.groups.length);
    for (let groupOffset = 0; groupOffset < newGroups.length; groupOffset++) {
      const sourceGroup = newGroups[groupOffset]!;
      if (sourceGroup.id !== base.groups.length + groupOffset)
        throw new DylinkWorkerSnapshotError("EINVAL", "Worker extension group order is invalid");
      const externalSymbols = new Map<string, DylinkExternalSymbol>();
      for (const entry of sourceGroup.externalSymbols) {
        const symbol = this.#restoreWorkerSymbol(entry, resolveExport);
        externalSymbols.set(entry[0], symbol);
        if (typeof symbol.value === "function" && symbol.address !== undefined)
          setStagePointer(symbol.value, symbol.address);
      }
      const functionMetadata = new Map<
        string,
        ReadonlyMap<string, { signature: string; imported: boolean }>
      >();
      const replayFunctionSlots = new Map(
        sourceGroup.functionSlots.map(([key, slots]) => [key, new Map(slots)] as const),
      );
      let group: Group;
      try {
        group = link_dylink_graph({
          root: sourceGroup.root,
          files: fileBytes,
          memory: this.#options.memory,
          table: this.#table,
          tailTable: stage.tailTable,
          stack: this.#stack,
          memoryMaximumPages: BigInt(this.#options.maximumPages),
          tableMaximumElements: this.#options.tableType.maximum,
          memoryArena: {
            cursor: 1n,
            limit: BigInt(this.#options.memory.buffer.byteLength),
            address: this.#options.address,
          },
          tableArena: {
            cursor: base.main.cursor,
            limit: BigInt(nextSnapshot.main.tableLength),
            address: this.#options.tableType.address,
          },
          hostFunctions,
          hostGlobals,
          externalSymbols,
          externalTags: this.#tags,
          functionPointers: stage.pointers,
          lazyFunctions: sourceGroup.lazyFunctions.length > 0,
          replay: {
            placements: new Map(sourceGroup.placements),
            functionSlots: replayFunctionSlots,
            deferTableWrites: true,
          },
          reuse: replayReuse,
          resolveDependency: (name, parent) => {
            const key = filesByKey.get(parent)?.dependencies.get(name);
            if (!key)
              throw new DylinkWorkerSnapshotError(
                "EINVAL",
                `publication lacks dependency ${parent} -> ${name}`,
              );
            return key;
          },
          isControlFlow: this.#options.isControlFlow,
          execution: {
            prepare: (name, sourceBytes) => {
              const prepared = prepare_dylink_call_metadata(sourceBytes);
              functionMetadata.set(name, prepared.functions);
              return new WebAssembly.Module(prepared.bytes);
            },
            instantiate: (_name, action) => action(),
            register: (name, instance) => {
              const owner = stageOwners.get(name);
              const metadata = functionMetadata.get(name);
              if (owner === undefined || !metadata)
                throw new DylinkWorkerSnapshotError(
                  "EINVAL",
                  `publication lacks caller metadata for ${name}`,
                );
              for (const [alias, description] of metadata) {
                const fn = instance.exports[alias];
                if (typeof fn !== "function")
                  throw new DylinkWorkerSnapshotError(
                    "EINVAL",
                    `publication function alias ${name}.${alias} is missing`,
                  );
                if (!stage.functions.has(fn) && !this.#functions.has(fn))
                  stage.functions.set(
                    fn,
                    description.imported
                      ? { owner: null, signature: description.signature }
                      : { owner, addressOwner: owner, signature: description.signature },
                  );
              }
              stageInstances.set(name, instance);
            },
            callable: stageCallable,
            tailCallable: stageTailCallable,
            settleTable: () => {},
          },
        });
      } catch (error) {
        if (error instanceof DylinkWorkerSnapshotError) throw error;
        if (error instanceof RangeError)
          throw new DylinkWorkerSnapshotError("ENOMEM", "cannot prepare Worker module extension", {
            cause: error,
          });
        if (error instanceof WebAssembly.CompileError || error instanceof WebAssembly.LinkError)
          throw new DylinkWorkerSnapshotError(
            "EOPNOTSUPP",
            "Worker module extension cannot be instantiated",
            { cause: error },
          );
        throw new DylinkWorkerSnapshotError("EINVAL", "Worker module extension replay failed", {
          cause: error,
        });
      }

      for (const [fn, slot] of group.replayFunctionPointers) setStagePointer(fn, slot);
      for (const write of group.replayTableWrites) {
        if (write.index < base.main.cursor) continue; // Reused records retain their old table image.
        addWrite(write.index, write.value, write.tailValue);
      }
      stage.groups.push({ group, root: sourceGroup.root, externalSymbols });
      for (const [key, record] of group.records) {
        if (!record.instance)
          throw new DylinkWorkerSnapshotError(
            "EINVAL",
            `Worker extension module ${key} was not instantiated`,
          );
        if (stage.files.has(key)) {
          replayReuse.set(key, record);
          stage.reuse.set(key, record);
        }
        stageInstances.set(key, record.instance);
      }
    }

    // Add newly assigned slots for main and already resident groups. The
    // snapshot aliases are canonical; staged table entries remain private.
    for (const [name, slot] of nextSnapshot.main.functionSlots.slice(
      base.main.functionSlots.length,
    )) {
      const fn = this.#options.main.exports[name];
      if (typeof fn !== "function")
        throw new DylinkWorkerSnapshotError(
          "EINVAL",
          `Worker extension main export ${name} is missing`,
        );
      setStagePointer(fn, slot);
    }
    for (let groupId = 0; groupId < base.groups.length; groupId++) {
      const before = new Map(
        base.groups[groupId]!.functionSlots.map(([key, slots]) => [key, new Map(slots)] as const),
      );
      const after = nextSnapshot.groups[groupId]!;
      for (const [key, slots] of after.functionSlots) {
        const oldSlots = before.get(key) ?? new Map<string, bigint>();
        for (const [alias, slot] of slots) {
          if (oldSlots.has(alias)) {
            if (oldSlots.get(alias) !== slot)
              throw new DylinkWorkerSnapshotError(
                "EINVAL",
                `Worker extension changes ${key}.${alias} slot`,
              );
            continue;
          }
          const fn = resolveExport(key, alias);
          if (typeof fn !== "function")
            throw new DylinkWorkerSnapshotError(
              "EINVAL",
              `Worker extension export ${key}.${alias} is missing`,
            );
          setStagePointer(fn, slot);
        }
      }
    }

    // New-module table writes come from the deferred linker. Publication slots
    // also include canonical aliases created while the parent reserved dlsym
    // addresses; resolve and stage those without touching the Worker table.
    for (let index = 0; index < nextSnapshot.main.tableSlots.length; index++) {
      const slot = nextSnapshot.main.tableSlots[index];
      const oldSlot = base.main.tableSlots[index];
      if (!slot || (oldSlot !== null && oldSlot !== undefined)) continue;
      const fn = resolveExport(slot.moduleKey, slot.exportAlias);
      if (typeof fn !== "function")
        throw new DylinkWorkerSnapshotError(
          "EINVAL",
          `Worker extension table export ${slot.moduleKey}.${slot.exportAlias} is missing`,
        );
      const wrapped = stageCallable(fn);
      const tail = stage.tailTable ? stageTailCallable(fn) : undefined;
      addWrite(BigInt(index), wrapped, tail);
    }

    for (const [index, write] of stage.tableWrites) {
      const descriptor = nextSnapshot.main.tableSlots[Number(index)];
      if (write.value === null) {
        if (descriptor)
          throw new DylinkWorkerSnapshotError(
            "EINVAL",
            `Worker extension clears published table slot ${index}`,
          );
        continue;
      }
      if (!descriptor)
        throw new DylinkWorkerSnapshotError(
          "EINVAL",
          `Worker extension writes an unpublished table slot ${index}`,
        );
      const fn = resolveExport(descriptor.moduleKey, descriptor.exportAlias);
      if (typeof fn !== "function" || stageCallable(fn) !== write.value)
        throw new DylinkWorkerSnapshotError(
          "EINVAL",
          `Worker extension table slot ${index} disagrees with its snapshot`,
        );
      if (stage.tailTable && stageTailCallable(fn) !== write.tailValue)
        throw new DylinkWorkerSnapshotError(
          "EINVAL",
          `Worker extension tail slot ${index} disagrees with its snapshot`,
        );
    }

    for (const source of nextSnapshot.objectGroups.slice(base.objectGroups.length)) {
      const [key, object] = source;
      const offset = object.groupId - base.groups.length;
      const groupState = stage.groups[offset];
      const file = stage.files.get(key);
      if (!groupState || !file || groupState.root !== object.root)
        throw new DylinkWorkerSnapshotError(
          "EINVAL",
          `Worker extension object ${key} is incomplete`,
        );
      file.handle = object.handle;
      const loaded: ObjectHandle = { group: groupState.group, root: key, handle: object.handle };
      stage.objects.set(key, loaded);
      stage.handles.set(object.handle, loaded);
    }

    for (const [name, descriptor] of nextSnapshot.symbols.slice(base.symbols.length)) {
      const symbol = this.#restoreWorkerSymbol([name, descriptor], resolveExport);
      stage.symbols.set(name, symbol);
      if (typeof symbol.value === "function" && symbol.address !== undefined)
        setStagePointer(symbol.value, symbol.address);
    }

    for (const pending of [
      ...this.#lazyFunctions,
      ...stage.groups.flatMap((state) => state.group.lazyFunctions),
    ]) {
      const symbol = stage.symbols.get(pending.name) ?? this.#symbols.get(pending.name);
      if (!symbol) {
        stage.lazyFunctions.push(pending);
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
      let address = symbol.address;
      if (address === undefined && typeof symbol.value === "function")
        address = stage.pointers.get(symbol.value) ?? this.#pointers.get(symbol.value);
      if (address === undefined)
        throw new DylinkWorkerSnapshotError(
          "EOPNOTSUPP",
          `lazy symbol ${pending.name} has no reserved canonical slot`,
        );
      stage.lazyWrites.push({
        target: pending.target,
        previous: pending.target.value as number | bigint,
        next: this.#word(address, this.#options.tableType.address),
      });
    }

    for (const [key, file] of stage.files) {
      if (!stage.objects.has(key))
        throw new DylinkWorkerSnapshotError(
          "EINVAL",
          `Worker extension file ${key} has no object group`,
        );
    }
    for (const [index, slot] of nextSnapshot.main.tableSlots.entries()) {
      const oldSlot = base.main.tableSlots[index];
      if ((oldSlot !== null && oldSlot !== undefined) || !slot) continue;
      if (!stage.tableWrites.has(BigInt(index)))
        throw new DylinkWorkerSnapshotError(
          "EINVAL",
          `Worker extension did not stage table slot ${index}`,
        );
    }

    // If this extension first needs a private tail table, construct the full
    // candidate table off to the side. It becomes visible only at commit.
    if (stage.installsTailTable && stage.tailTable) {
      const set = stage.tailTable.set as unknown as (
        index: WasmAddress,
        fn: CallableFunction | null,
      ) => void;
      for (const [index, write] of stage.tableWrites)
        set.call(
          stage.tailTable,
          this.#word(index, this.#options.tableType.address),
          write.tailValue ?? null,
        );
    }

    const token = Object.freeze({});
    workerExtensionCandidates.set(token, {
      process: this,
      revision,
      priorState,
      stage,
    });
    return token;
  }

  /** Commit a prepared graph while the caller holds its Worker publication
   * barrier. The returned state is the only generation eligible for the next
   * append-only publication. */
  commitWorkerExtension(candidate: DylinkWorkerExtensionCandidate): DylinkWorkerPublicationState {
    const receipt = this.commitWorkerExtensionProvisional(candidate);
    return this.finalizeWorkerExtension(receipt);
  }

  /** Provisional graph commit. Keep the returned receipt until every Worker
   * has acknowledged the same generation; loader entrypoints stay blocked. */
  commitWorkerExtensionProvisional(
    candidate: DylinkWorkerExtensionCandidate,
  ): DylinkWorkerExtensionReceipt {
    if (this.#workerExtensionPendingFailure())
      throw new DylinkWorkerSnapshotError(
        "EOPNOTSUPP",
        "another Worker graph publication is provisional",
      );
    const data = workerExtensionCandidates.get(candidate);
    if (!data || data.process !== this)
      throw new DylinkWorkerSnapshotError(
        "EINVAL",
        "Worker extension candidate is invalid, already consumed, or belongs to another process",
      );
    const { priorState, stage } = data;
    if (
      this.#workerPublicationState !== priorState ||
      this.#workerGraphRevision !== data.revision ||
      this.#workerGraphRevision !== this.#workerPublicationRevision ||
      priorState.processIdentity !== this.#workerPublicationState.processIdentity ||
      priorState.generation !== this.#workerPublicationState.generation ||
      priorState.snapshot !== this.#workerPublicationState.snapshot ||
      this.#busy ||
      this.#addressBusy ||
      this.#caller.value !== 0
    )
      throw new DylinkWorkerSnapshotError(
        "EINVAL",
        "Worker extension candidate became stale before commit",
      );
    if (BigInt(this.#table.length) < BigInt(stage.nextSnapshot.main.tableLength))
      throw new DylinkWorkerSnapshotError(
        "EINVAL",
        "Worker extension table capacity was lost before commit",
      );
    if (this.#tailTable && BigInt(this.#tailTable.length) !== BigInt(this.#table.length))
      throw new DylinkWorkerSnapshotError(
        "EINVAL",
        "Worker canonical and tail tables diverged before commit",
      );

    type MapChange = { map: Map<any, any>; key: any; value: any };
    const mapChanges: MapChange[] = [];
    const addChanges = <K, V>(target: Map<K, V>, source: ReadonlyMap<K, V>, label: string) => {
      for (const [key, value] of source) {
        if (target.has(key)) {
          if (target.get(key) !== value)
            throw new DylinkWorkerSnapshotError(
              "EINVAL",
              `Worker extension conflicts with existing ${label}`,
            );
          continue;
        }
        mapChanges.push({ map: target, key, value });
      }
    };
    addChanges(this.#files, stage.files, "file");
    addChanges(this.#groups, stage.objects, "object group");
    addChanges(this.#handles, stage.handles, "object handle");
    addChanges(this.#reuse, stage.reuse, "module record");
    addChanges(this.#symbols, stage.symbols, "symbol");
    addChanges(this.#aliases, stage.aliases, "alias");
    addChanges(this.#owners, stage.owners, "caller owner");
    addChanges(this.#ownerNames, stage.ownerNames, "caller owner ID");
    addChanges(this.#addressNames, stage.addressNames, "symbol name address");
    addChanges(this.#functions, stage.functions, "function metadata");
    addChanges(this.#wrappers, stage.wrappers, "call wrapper");
    addChanges(this.#tailWrappers, stage.tailWrappers, "tail-call wrapper");
    addChanges(this.#originals, stage.originals, "wrapper identity");
    addChanges(this.#pointers, stage.pointers, "function pointer");

    const canonicalGet = (index: bigint) =>
      wasm_table_get(this.#table, this.#word(index, this.#options.tableType.address));
    const canonicalSet = this.#table.set as unknown as (
      index: WasmAddress,
      fn: CallableFunction | null,
    ) => void;
    const existingTail = this.#tailTable;
    const previousTailTable = this.#tailTable;
    const tailGet = existingTail
      ? (index: bigint) =>
          wasm_table_get(existingTail, this.#word(index, this.#options.tableType.address))
      : undefined;
    const tailSet = existingTail?.set as
      | ((index: WasmAddress, fn: CallableFunction | null) => void)
      | undefined;
    const writes = [...stage.tableWrites].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    const oldValues = writes.map(([index]) => ({
      index,
      canonical: canonicalGet(index),
      ...(tailGet ? { tail: tailGet(index) } : {}),
    }));

    let appliedWrites = 0;
    const rollbackTables = () => {
      let rollbackFailed = false;
      for (let index = appliedWrites - 1; index >= 0; index--) {
        const old = oldValues[index]!;
        const address = this.#word(old.index, this.#options.tableType.address);
        try {
          canonicalSet.call(this.#table, address, old.canonical);
          if (tailSet && "tail" in old) tailSet.call(existingTail!, address, old.tail ?? null);
        } catch {
          rollbackFailed = true;
        }
      }
      if (rollbackFailed)
        this.#options.fatal(
          new DylinkInitializationError(new Error("Worker extension table rollback failed")),
        );
    };

    const previousGroupLength = this.#replayGroups.length;
    const previousGlobalLength = this.#globalOrder.length;
    const previousLazyFunctions = this.#lazyFunctions;
    const previousMainHandle = this.#mainHandle;
    const previousLastMap = this.#lastMap;
    const previousCursor = this.#cursor;
    const previousNextOwner = this.#nextOwner;
    const previousWorkerState = this.#workerPublicationState;
    const previousPublicationRevision = this.#workerPublicationRevision;
    const previousRevision = this.#workerGraphRevision;
    const previousError = this.#error;
    let appliedMapChanges = 0;
    let receipt: DylinkWorkerExtensionReceipt | undefined;
    try {
      for (const [index, write] of writes) {
        const address = this.#word(index, this.#options.tableType.address);
        canonicalSet.call(this.#table, address, write.value);
        appliedWrites++;
        if (tailSet) tailSet.call(existingTail!, address, write.tailValue ?? null);
      }
      for (const change of mapChanges) {
        change.map.set(change.key, change.value);
        appliedMapChanges++;
      }
      for (const group of stage.groups) this.#replayGroups.push(group);
      for (const key of stage.globalOrder) this.#globalOrder.push(key);
      for (const update of stage.lazyWrites) update.target.value = update.next;
      this.#lazyFunctions = stage.lazyFunctions;
      if (stage.installsTailTable) this.#tailTable = stage.tailTable ?? null;
      this.#mainHandle = stage.nextSnapshot.main.handle;
      this.#lastMap = stage.nextSnapshot.main.lastMap;
      this.#cursor = stage.nextSnapshot.main.cursor;
      this.#nextOwner = stage.nextOwner;
      const nextState: WorkerPublicationState = Object.freeze({
        processIdentity: priorState.processIdentity,
        generation: stage.nextGeneration,
        snapshot: stage.nextSnapshot,
      });
      this.#workerPublicationState = nextState;
      this.#touchWorkerGraph();
      this.#workerPublicationRevision = this.#workerGraphRevision;
      receipt = Object.freeze({});
      workerExtensionReceipts.set(receipt, {
        process: this,
        priorState,
        nextState,
        priorRevision: previousRevision,
        committedRevision: this.#workerGraphRevision,
        priorPublicationRevision: previousPublicationRevision,
        priorGroupLength: previousGroupLength,
        committedGroupLength: this.#replayGroups.length,
        priorGlobalLength: previousGlobalLength,
        committedGlobalLength: this.#globalOrder.length,
        priorLazyFunctions: previousLazyFunctions,
        priorTailTable: previousTailTable,
        committedTailTable: this.#tailTable,
        priorMainHandle: previousMainHandle,
        priorLastMap: previousLastMap,
        priorCursor: previousCursor,
        priorNextOwner: previousNextOwner,
        priorError: previousError,
        mapChanges,
        tableValues: writes.map(([index, write], position) => ({
          index,
          canonical: oldValues[position]!.canonical,
          ...(tailGet ? { tail: oldValues[position]!.tail } : {}),
          nextCanonical: write.value,
          ...(stage.tailTable ? { nextTail: write.tailValue ?? null } : {}),
        })),
        lazyWrites: stage.lazyWrites,
      });
      this.#workerExtensionReceipt = receipt;
      workerExtensionCandidates.delete(candidate);
      return receipt;
    } catch (error) {
      if (receipt) workerExtensionReceipts.delete(receipt);
      this.#lazyFunctions = previousLazyFunctions;
      this.#replayGroups.length = previousGroupLength;
      this.#globalOrder.length = previousGlobalLength;
      while (appliedMapChanges > 0) {
        const change = mapChanges[--appliedMapChanges]!;
        change.map.delete(change.key);
      }
      this.#workerPublicationState = previousWorkerState;
      this.#workerPublicationRevision = previousPublicationRevision;
      this.#workerExtensionReceipt = null;
      this.#tailTable = previousTailTable;
      this.#mainHandle = previousMainHandle;
      this.#lastMap = previousLastMap;
      this.#cursor = previousCursor;
      this.#nextOwner = previousNextOwner;
      this.#workerGraphRevision = previousRevision;
      rollbackTables();
      try {
        for (const update of [...stage.lazyWrites].reverse()) update.target.value = update.previous;
      } catch {
        this.#options.fatal(
          new DylinkInitializationError(new Error("Worker extension lazy binding rollback failed")),
        );
      }
      throw error;
    }
  }

  #workerExtensionReceiptData(receipt: DylinkWorkerExtensionReceipt): WorkerExtensionReceiptData {
    const data = workerExtensionReceipts.get(receipt);
    if (!data || data.process !== this || this.#workerExtensionReceipt !== receipt)
      throw new DylinkWorkerSnapshotError(
        "EINVAL",
        "Worker extension receipt is invalid, stale, already consumed, or belongs to another process",
      );
    if (this.#busy || this.#addressBusy || this.#caller.value !== 0)
      throw new DylinkWorkerSnapshotError(
        "EOPNOTSUPP",
        "Worker extension receipt requires an idle loader",
      );

    const fatalMismatch = (message: string): never =>
      this.#options.fatal(new DylinkInitializationError(new Error(message)));
    if (
      this.#workerPublicationState !== data.nextState ||
      this.#workerGraphRevision !== data.committedRevision ||
      this.#workerPublicationRevision !== data.committedRevision ||
      this.#replayGroups.length !== data.committedGroupLength ||
      this.#globalOrder.length !== data.committedGlobalLength ||
      this.#tailTable !== data.committedTailTable ||
      this.#mainHandle !== data.nextState.snapshot.main.handle ||
      this.#lastMap !== data.nextState.snapshot.main.lastMap ||
      this.#cursor !== data.nextState.snapshot.main.cursor
    )
      fatalMismatch("Worker extension receipt graph state diverged after provisional commit");
    for (const change of data.mapChanges) {
      if (!change.map.has(change.key) || change.map.get(change.key) !== change.value)
        fatalMismatch("Worker extension receipt map state diverged after provisional commit");
    }
    for (const write of data.tableValues) {
      const address = this.#word(write.index, this.#options.tableType.address);
      if (wasm_table_get(this.#table, address) !== write.nextCanonical)
        fatalMismatch("Worker extension receipt table diverged after provisional commit");
      if (
        "nextTail" in write &&
        (!this.#tailTable || wasm_table_get(this.#tailTable, address) !== (write.nextTail ?? null))
      )
        fatalMismatch("Worker extension receipt tail table diverged after provisional commit");
    }
    for (const update of data.lazyWrites) {
      if (update.target.value !== update.next)
        fatalMismatch("Worker extension receipt lazy binding diverged after provisional commit");
    }
    return data;
  }

  /** Accept a provisional graph commit and release its local loader gate. */
  finalizeWorkerExtension(receipt: DylinkWorkerExtensionReceipt): DylinkWorkerPublicationState {
    const data = this.#workerExtensionReceiptData(receipt);
    workerExtensionReceipts.delete(receipt);
    this.#workerExtensionReceipt = null;
    this.#error = data.priorError;
    return data.nextState;
  }

  /** Restore the exact pre-commit graph. Empty table growth may remain, but no
   * newly assigned slot, binding, handle or loader state remains visible. */
  rollbackWorkerExtension(receipt: DylinkWorkerExtensionReceipt): void {
    const data = this.#workerExtensionReceiptData(receipt);
    let rollbackError: unknown;
    const rememberFailure = (error: unknown) => {
      rollbackError ??= error;
    };

    const tableSet = this.#table.set as unknown as (
      index: WasmAddress,
      fn: CallableFunction | null,
    ) => void;
    const priorTail = data.priorTailTable;
    const tailSet = priorTail?.set as
      | ((index: WasmAddress, fn: CallableFunction | null) => void)
      | undefined;
    for (let index = data.tableValues.length - 1; index >= 0; index--) {
      const value = data.tableValues[index]!;
      const address = this.#word(value.index, this.#options.tableType.address);
      try {
        tableSet.call(this.#table, address, value.canonical);
      } catch (error) {
        rememberFailure(error);
      }
      if (tailSet && "tail" in value) {
        try {
          tailSet.call(priorTail!, address, value.tail ?? null);
        } catch (error) {
          rememberFailure(error);
        }
      }
    }
    for (let index = data.lazyWrites.length - 1; index >= 0; index--) {
      const update = data.lazyWrites[index]!;
      try {
        update.target.value = update.previous;
      } catch (error) {
        rememberFailure(error);
      }
    }
    for (let index = data.mapChanges.length - 1; index >= 0; index--) {
      const change = data.mapChanges[index]!;
      change.map.delete(change.key);
    }
    this.#replayGroups.length = data.priorGroupLength;
    this.#globalOrder.length = data.priorGlobalLength;
    this.#lazyFunctions = data.priorLazyFunctions;
    this.#tailTable = data.priorTailTable;
    this.#mainHandle = data.priorMainHandle;
    this.#lastMap = data.priorLastMap;
    this.#cursor = data.priorCursor;
    this.#nextOwner = data.priorNextOwner;
    this.#workerPublicationState = data.priorState;
    this.#workerPublicationRevision = data.priorPublicationRevision;
    this.#workerGraphRevision = data.priorRevision;
    this.#error = data.priorError;
    this.#workerExtensionReceipt = null;
    workerExtensionReceipts.delete(receipt);

    if (rollbackError !== undefined)
      this.#options.fatal(
        new DylinkInitializationError(
          new Error("Worker extension rollback failed", { cause: rollbackError }),
        ),
      );
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
    this.#error = "dynamic loading is disabled in the current process state";
    return true;
  }
  #queryBlockedFailure() {
    if (this.#workerExtensionPendingFailure()) return true;
    if (!(this.#options.queryBlocked ?? this.#options.blocked)()) return false;
    this.#error = "dynamic queries are disabled while a vfork child is active";
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
      this.#touchWorkerGraph();
    }
    this.#rememberWorkerPublicationSymbolUndo(symbol);
    symbol.address = pointer;
    return pointer;
  }
  #stableQueryAddress(symbol: DylinkExternalSymbol): bigint {
    if (typeof symbol.value !== "function") {
      if (symbol.address === undefined)
        throw new DylinkWorkerSnapshotError(
          "EOPNOTSUPP",
          "dynamic data symbol has no stable address",
        );
      return symbol.address;
    }

    const raw = this.#originals.get(symbol.value) ?? symbol.value;
    const pointer = this.#pointers.get(symbol.value) ?? this.#pointers.get(raw) ?? symbol.address;
    if (
      pointer === undefined ||
      !wasm_table_get(this.#table, this.#word(pointer, this.#options.tableType.address))
    )
      throw new DylinkWorkerSnapshotError(
        "EOPNOTSUPP",
        "dynamic function slot was not reserved before Worker replay",
      );
    return pointer;
  }
  #reservePublishedFunctionSlots() {
    const reserve = (name: string, symbol: DylinkExternalSymbol | undefined) => {
      if (!symbol || typeof symbol.value !== "function") return;
      const pointer = this.#address(symbol);
      if (this.#stableQueryAddress(symbol) !== pointer)
        throw new DylinkWorkerSnapshotError(
          "EOPNOTSUPP",
          `function slot for ${name} is not stable for Worker replay`,
        );
    };

    for (const [name, symbol] of this.#symbols) reserve(`main.${name}`, symbol);
    for (const state of this.#replayGroups) {
      for (const key of state.group.order) {
        const file = this.#files.get(key);
        if (!file)
          throw new DylinkWorkerSnapshotError("EINVAL", `dynamic module ${key} is missing`);
        for (const entry of WebAssembly.Module.exports(file.module)) {
          if (entry.kind !== "function") continue;
          reserve(`${key}.${entry.name}`, state.group.lookupOwn(key, entry.name));
        }
      }
    }
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
    this.#trackWorkerPublicationAllocation(pointer);
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
    this.#touchWorkerGraph();
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
    this.#touchWorkerGraph();
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
    let changed = false;
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
      this.#rememberWorkerPublicationLazyGlobalUndo(pending.target);
      pending.target.value = this.#word(this.#address(symbol), this.#options.tableType.address);
      changed = true;
    }
    this.#lazyFunctions = unresolved;
    if (changed) this.#touchWorkerGraph();
  }
  #createWorkerPublicationOwnerRollback(): WorkerPublicationOwnerRollbackState {
    const wordBytes = this.#options.address === "i64" ? 8 : 4;
    let lastMapBytes: Uint8Array<ArrayBuffer> | null = null;
    if (this.#lastMap) {
      const bytes = memory_bytes(this.#options.memory, this.#word(this.#lastMap), 5 * wordBytes);
      if (!bytes) throw new Error("cannot capture the current dynamic link map");
      lastMapBytes = new Uint8Array(bytes);
    }
    const snapshot: WorkerPublicationOwnerRollbackSnapshot = {
      // Group.lookupOwn returns the original symbol object. Keep those object
      // identities and separately undo the few fields that the address
      // allocator can mutate; replacing them with clones leaves the group and
      // the process symbol map describing different symbols after rollback.
      symbols: new Map(this.#symbols),
      pointers: new Map(this.#pointers),
      files: new Map(this.#files),
      aliases: new Map(this.#aliases),
      reuse: new Map(this.#reuse),
      groups: new Map(this.#groups),
      replayGroups: [...this.#replayGroups],
      addressNames: new Map(this.#addressNames),
      handles: new Map(this.#handles),
      globalOrder: [...this.#globalOrder],
      owners: new Map(this.#owners),
      ownerNames: new Map(this.#ownerNames),
      functions: new Map(this.#functions),
      wrappers: new Map(this.#wrappers),
      tailWrappers: new Map(this.#tailWrappers),
      originals: new Map(this.#originals),
      lazyFunctions: [...this.#lazyFunctions],
      mainHandle: this.#mainHandle,
      lastMap: this.#lastMap,
      lastMapBytes,
      cursor: this.#cursor,
      nextOwner: this.#nextOwner,
      tailTable: this.#tailTable,
      error: this.#error,
      workerPublicationState: this.#workerPublicationState,
      workerPublicationRevision: this.#workerPublicationRevision,
      workerGraphRevision: this.#workerGraphRevision,
    };
    const state: WorkerPublicationOwnerRollbackState = {
      phase: "open",
      snapshot,
      tableUndo: new Map<bigint, WorkerPublicationTableUndo>(),
      symbolUndo: new Map<DylinkExternalSymbol, WorkerPublicationSymbolUndo>(),
      lazyGlobalUndo: new Map<WebAssembly.Global, number | bigint>(),
      persistentAllocations: [],
      pins: [],
      token: undefined as unknown as DylinkWorkerOwnerRollback,
    };

    const restoreMap = <K, V>(target: Map<K, V>, saved: Map<K, V>) => {
      target.clear();
      for (const [key, value] of saved) target.set(key, value);
    };
    const token: DylinkWorkerOwnerRollback = Object.freeze({
      restore: () => {
        if (state.phase !== "open" || !state.snapshot)
          throw new Error("Worker owner rollback restore is out of order");
        const saved = state.snapshot;
        try {
          const tableSet = this.#table.set as unknown as (
            index: WasmAddress,
            value: CallableFunction | null,
          ) => void;
          const tailTable = this.#tailTable;
          const tailSet = tailTable?.set as
            | ((index: WasmAddress, value: CallableFunction | null) => void)
            | undefined;
          for (let index = saved.cursor; index < BigInt(this.#table.length); index++) {
            const address = this.#word(index, this.#options.tableType.address);
            tableSet.call(this.#table, address, null);
            if (tailSet) tailSet.call(tailTable!, address, null);
          }
          for (const [index, old] of state.tableUndo) {
            const address = this.#word(index, this.#options.tableType.address);
            tableSet.call(this.#table, address, old.canonical);
            if (saved.tailTable && "tail" in old) {
              const oldTailSet = saved.tailTable.set as unknown as (
                index: WasmAddress,
                value: CallableFunction | null,
              ) => void;
              oldTailSet.call(saved.tailTable, address, old.tail ?? null);
            }
          }

          for (const [symbol, old] of state.symbolUndo) {
            if (old.hadAddress) symbol.address = old.address;
            else delete symbol.address;
          }
          for (const [target, previous] of state.lazyGlobalUndo) target.value = previous;

          if (saved.lastMapBytes) {
            const oldLinkMap = memory_bytes(
              this.#options.memory,
              this.#word(saved.lastMap),
              saved.lastMapBytes.length,
            );
            if (!oldLinkMap)
              throw new Error("the previous dynamic link map is no longer accessible");
            oldLinkMap.set(saved.lastMapBytes);
          }

          restoreMap(this.#symbols, saved.symbols);
          restoreMap(this.#pointers, saved.pointers);
          restoreMap(this.#files, saved.files);
          restoreMap(this.#aliases, saved.aliases);
          restoreMap(this.#reuse, saved.reuse);
          restoreMap(this.#groups, saved.groups);
          this.#replayGroups.splice(0, this.#replayGroups.length, ...saved.replayGroups);
          restoreMap(this.#addressNames, saved.addressNames);
          restoreMap(this.#handles, saved.handles);
          this.#globalOrder.splice(0, this.#globalOrder.length, ...saved.globalOrder);
          restoreMap(this.#owners, saved.owners);
          restoreMap(this.#ownerNames, saved.ownerNames);
          restoreMap(this.#functions, saved.functions);
          restoreMap(this.#wrappers, saved.wrappers);
          restoreMap(this.#tailWrappers, saved.tailWrappers);
          restoreMap(this.#originals, saved.originals);
          this.#lazyFunctions = [...saved.lazyFunctions];
          this.#mainHandle = saved.mainHandle;
          this.#lastMap = saved.lastMap;
          this.#cursor = saved.cursor;
          this.#nextOwner = saved.nextOwner;
          this.#tailTable = saved.tailTable;
          this.#error = saved.error;
          this.#workerPublicationState = saved.workerPublicationState;
          this.#workerPublicationRevision = saved.workerPublicationRevision;
          this.#workerGraphRevision = saved.workerGraphRevision;
          if (this.#workerPublicationAdvanceContext)
            this.#workerPublicationAdvanceContext.advanced = false;
          if (this.#workerPublicationOpenScope) {
            this.#workerPublicationOpenScope.advanced = false;
            this.#workerPublicationOpenScope.reopened = false;
          }
          state.phase = "restored";
        } catch (error) {
          this.#options.fatal(
            new DylinkInitializationError(
              new Error("Worker owner publication rollback failed", { cause: error }),
            ),
          );
        }
      },
      release: () => {
        if (state.phase !== "restored" || !state.snapshot)
          throw new Error("Worker owner rollback release requires a completed restore");
        state.phase = "releasing";
        for (let index = state.pins.length - 1; index >= 0; index--)
          this.#unpin(state.pins[index]!);
        for (let index = state.persistentAllocations.length - 1; index >= 0; index--)
          this.#call("__wasm_dlopen_deallocate", state.persistentAllocations[index]!);
        state.pins.length = 0;
        state.persistentAllocations.length = 0;
        state.tableUndo.clear();
        state.symbolUndo.clear();
        state.lazyGlobalUndo.clear();
        state.snapshot = null;
        state.phase = "released";
      },
      commit: () => {
        if (state.phase !== "open" || !state.snapshot)
          throw new Error("Worker owner rollback commit is out of order");
        state.pins.length = 0;
        state.persistentAllocations.length = 0;
        state.tableUndo.clear();
        state.symbolUndo.clear();
        state.lazyGlobalUndo.clear();
        state.snapshot = null;
        state.phase = "committed";
      },
    });
    state.token = token;
    return state;
  }
  #rememberWorkerPublicationTableUndo(
    index: bigint,
    canonical: CallableFunction | null,
    tail: CallableFunction | null,
  ) {
    const state = this.#workerPublicationOpenScope?.rollback;
    const snapshot = state?.snapshot;
    if (
      !state ||
      state.phase !== "open" ||
      !snapshot ||
      index >= snapshot.cursor ||
      state.tableUndo.has(index)
    )
      return;
    state.tableUndo.set(index, {
      canonical,
      ...(snapshot.tailTable && this.#tailTable === snapshot.tailTable ? { tail } : {}),
    });
  }
  #rememberWorkerPublicationSymbolUndo(symbol: DylinkExternalSymbol) {
    const rollback = this.#workerPublicationOpenScope?.rollback;
    if (!rollback || rollback.phase !== "open" || rollback.symbolUndo.has(symbol)) return;
    rollback.symbolUndo.set(symbol, {
      hadAddress: symbol.address !== undefined,
      ...(symbol.address === undefined ? {} : { address: symbol.address }),
    });
  }
  #rememberWorkerPublicationLazyGlobalUndo(target: WebAssembly.Global) {
    const rollback = this.#workerPublicationOpenScope?.rollback;
    if (!rollback || rollback.phase !== "open" || rollback.lazyGlobalUndo.has(target)) return;
    const value = target.value;
    if (typeof value !== "number" && typeof value !== "bigint")
      throw new Error("dynamic lazy binding global has an unsupported value type");
    rollback.lazyGlobalUndo.set(target, value);
  }
  #trackWorkerPublicationAllocation(pointer: WasmAddress) {
    const rollback = this.#workerPublicationOpenScope?.rollback;
    if (rollback?.phase === "open") rollback.persistentAllocations.push(pointer);
  }
  /** Explicit producer path for adding one replayable local group after
   * Workers exist. The ordinary open() path keeps its post-thread rejection. */
  openWithWorkerPublication(
    pathPointer: WasmAddress,
    flags: number,
    processIdentity: string,
    baseGeneration: number,
  ): WasmAddress {
    const fail = (message: string, code: "EOPNOTSUPP" | "EINVAL" = "EOPNOTSUPP") =>
      this.#failure(new DylinkWorkerSnapshotError(code, message));
    const state = this.#workerPublicationState;
    if (!this.#options.postThread?.())
      return fail("Worker publication producer requires an existing thread");
    if (typeof processIdentity !== "string" || processIdentity.length === 0)
      return fail("Worker publication identity is empty", "EINVAL");
    if (
      !Number.isSafeInteger(baseGeneration) ||
      baseGeneration < 0 ||
      baseGeneration >= Number.MAX_SAFE_INTEGER
    )
      return fail("Worker publication generation is invalid", "EINVAL");
    if (
      !state ||
      state.processIdentity !== processIdentity ||
      state.generation !== baseGeneration ||
      this.#workerGraphRevision !== this.#workerPublicationRevision
    )
      return fail(
        "Worker publication producer baseline is missing, mismatched, or stale",
        "EINVAL",
      );
    if (
      this.#busy ||
      this.#addressBusy ||
      this.#caller.value !== 0 ||
      this.#workerExtensionReceipt ||
      this.#workerPublicationOpenScope ||
      this.#workerPublicationAdvanceContext
    )
      return fail("Worker publication producer requires an idle loader");
    if (!this.#options.queryBlocked || this.#options.queryBlocked())
      return fail("Worker publication producer is blocked by vfork");
    if (!this.#options.beforeInitialize || !(this.#options.beforeInitializeActive?.() ?? true))
      return fail("Worker publication producer has no pre-initialization barrier");
    if (!this.#unsigned(pathPointer))
      return fail("Worker publication producer requires a new module path", "EINVAL");
    if (flags & 256) return fail("RTLD_GLOBAL is disabled for post-thread Worker publication");

    let rollback: WorkerPublicationOwnerRollbackState;
    try {
      rollback = this.#createWorkerPublicationOwnerRollback();
    } catch (error) {
      return this.#failure(error);
    }

    const scope: WorkerPublicationOpenScope = {
      processIdentity,
      baseGeneration,
      baseState: state,
      baseRevision: this.#workerGraphRevision,
      authorizationPending: true,
      advanced: false,
      reopened: false,
      rollback,
    };
    this.#workerPublicationOpenScope = scope;
    try {
      const handle = this.open(pathPointer, flags);
      if (!this.#unsigned(handle) && rollback.phase === "open") rollback.token.commit();
      if (scope.reopened && rollback.phase === "open") rollback.token.commit();
      if (this.#unsigned(handle) && !scope.advanced && !scope.reopened)
        return fail("Worker publication completed without advancing the owner baseline");
      return handle;
    } finally {
      if (this.#workerPublicationOpenScope === scope) this.#workerPublicationOpenScope = null;
    }
  }
  open(pathPointer: WasmAddress, flags: number): WasmAddress {
    const postThread = this.#options.postThread?.() ?? false;
    const publicationScope = this.#workerPublicationOpenScope;
    const scopedPublicationOpen = !!publicationScope?.authorizationPending;
    if (scopedPublicationOpen) publicationScope!.authorizationPending = false;
    const publicationBaseState = this.#workerPublicationState;
    const publicationBaseRevision = this.#workerGraphRevision;
    if (this.#queryBlockedFailure()) return this.#word(0n);
    if (!postThread && this.#blockedFailure()) return this.#word(0n);
    if (this.#workerPublicationOpenScope && !scopedPublicationOpen)
      return this.#failure(
        new DylinkWorkerSnapshotError(
          "EOPNOTSUPP",
          "nested Worker publication open is not authorized",
        ),
      );
    let allocation: WasmAddress | undefined;
    let acquired = false;
    let committed = false;
    const pins = scopedPublicationOpen && publicationScope ? publicationScope.rollback.pins : [];
    try {
      if (flags & ~0x1107 || !(flags & 3)) throw new Error("invalid dlopen mode");
      if (!this.#unsigned(pathPointer) && this.#mainHandle) return this.#word(this.#mainHandle);
      if (postThread && this.#unsigned(pathPointer) && flags & 256)
        throw new Error("RTLD_GLOBAL is disabled after thread creation");
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
        if (postThread && !scopedPublicationOpen && !descriptorPath) {
          for (const candidate of candidates) {
            const known = aliases.get(candidate);
            if (known && local.has(known)) return local.get(known)!;
          }
          throw new Error("loading a new dynamic object is disabled after thread creation");
        }
        let failure: unknown = new Error(`dynamic library not found: ${name}`);
        for (const candidate of candidates) {
          const known = descriptorPath ? undefined : aliases.get(candidate);
          if (known && local.has(known)) return local.get(known)!;
          try {
            const file = this.#read(candidate, local);
            if (local.has(file.key)) {
              // #read returns the resident object before acquiring another
              // pin. Its existing reference must stay owned by that object.
              if (!descriptorPath) {
                aliases.set(candidate, file.key);
                if (!aliases.has(name)) aliases.set(name, file.key);
              }
              return local.get(file.key)!;
            }
            if (postThread && !scopedPublicationOpen) {
              this.#unpin(file.pin);
              throw new Error("loading a new dynamic object is disabled after thread creation");
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
      if (postThread && scopedPublicationOpen && old) {
        if (
          [...old.group.records.values()].some((record) => record.initialization?.state !== "done")
        )
          throw new Error("dynamic object is not fully initialized for thread-safe reopen");
        const scope = this.#workerPublicationOpenScope;
        if (!scope) throw new Error("Worker publication reopen has no active scope");
        scope.reopened = true;
        this.#busy = false;
        acquired = false;
        return this.#word(old.handle);
      }
      if (postThread && !scopedPublicationOpen) {
        if (!old) throw new Error("loading a new dynamic object is disabled after thread creation");
        if (
          [...old.group.records.values()].some((record) => record.initialization?.state !== "done")
        )
          throw new Error("dynamic object is not fully initialized for thread-safe reopen");
        this.#busy = false;
        acquired = false;
        return this.#word(old.handle);
      }
      if (old) {
        if (flags & 256) {
          this.#validateLazyFunctionTypes(old.group.symbolTypesFrom(old.root));
          this.#promote(old.group, old.root);
          this.#bindLazyFunctions();
        }
        for (const [name, key] of aliases) this.#aliases.set(name, key);
        if (aliases.size) this.#touchWorkerGraph();
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
      if (scopedPublicationOpen && fresh.length === 0)
        throw new Error("Worker publication producer requires at least one fresh dynamic module");
      if (scopedPublicationOpen)
        for (const file of fresh)
          validate_dylink_worker_replayable_module(file.key, file.bytes, this.#options.address);
      const importsByFile = new Map<string, ReturnType<typeof read_wasm_dynamic_imports>>();
      const externalSymbolNames = new Set<string>();
      for (const file of files) {
        const imports = read_wasm_dynamic_imports(file.bytes);
        importsByFile.set(file.key, imports);
        for (const entry of imports) {
          if (entry.module === "env" || entry.module === "GOT.func" || entry.module === "GOT.mem")
            externalSymbolNames.add(entry.name);
        }
        for (const entry of WebAssembly.Module.exports(file.module))
          externalSymbolNames.add(entry.name);
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
      if (allocation !== undefined) this.#trackWorkerPublicationAllocation(allocation);
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
          importsByFile.get(file.key)!.filter((entry) => entry.module === "GOT.func").length,
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
      const loadExternalSymbols = new Map<string, DylinkExternalSymbol>();
      for (const name of externalSymbolNames) {
        const symbol = this.#symbols.get(name);
        if (symbol) loadExternalSymbols.set(name, { ...symbol });
      }
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
      this.#replayGroups.push({
        group,
        root: root.key,
        externalSymbols: loadExternalSymbols,
      });
      if (flags & 256) {
        this.#promote(group, root.key);
        this.#bindLazyFunctions();
      }
      this.#touchWorkerGraph();
      allocation = undefined; // Resident until exec/exit, including dlclose.
      // Instances, GOT/TLS relocations and file ownership are complete. Publish
      // before constructors so recursive dlopen sees the same records and can
      // initialize other pending dependencies exactly once. Start/I/O/allocator
      // callbacks above remain guarded against reentrant graph construction.
      this.#busy = false;
      acquired = false;
      let publicationHookRan = false;
      if (this.#options.beforeInitialize && (this.#options.beforeInitializeActive?.() ?? true)) {
        publicationHookRan = true;
        if (this.#workerPublicationAdvanceContext)
          throw new DylinkWorkerSnapshotError(
            "EOPNOTSUPP",
            "nested dynamic initialization publication is unsupported",
          );
        const snapshot = this.#buildWorkerSnapshot();
        const context: WorkerPublicationAdvanceContext = {
          baseState: publicationBaseState,
          baseRevision: publicationBaseRevision,
          snapshot,
          targetSnapshot: publicationBaseState ? prepare_dylink_worker_snapshot(snapshot) : null,
          snapshotRevision: this.#workerGraphRevision,
          advanced: false,
        };
        this.#workerPublicationAdvanceContext = context;
        try {
          this.#options.beforeInitialize(
            snapshot,
            scopedPublicationOpen ? publicationScope?.rollback.token : undefined,
          );
        } finally {
          if (this.#workerPublicationAdvanceContext === context)
            this.#workerPublicationAdvanceContext = null;
        }
        if (scopedPublicationOpen && !context.advanced)
          throw new DylinkInitializationError(
            new Error("Worker publication barrier returned before advancing the owner baseline"),
          );
        if (scopedPublicationOpen && publicationScope?.rollback.phase !== "committed")
          throw new DylinkInitializationError(
            new Error(
              "Worker publication barrier returned before owner rollback state was committed",
            ),
          );
      }
      if (scopedPublicationOpen && !publicationHookRan && publicationScope) {
        publicationScope.rollback.token.restore();
        publicationScope.rollback.token.release();
        committed = false;
        throw new DylinkWorkerSnapshotError(
          "EOPNOTSUPP",
          "Worker publication barrier became inactive before the new group was published",
        );
      }
      group.ensureInitialized();
      return this.#word(root.handle!);
    } catch (error) {
      if (committed && error instanceof DylinkWorkerPublicationAbort) {
        if (!scopedPublicationOpen || publicationScope?.rollback.phase !== "released")
          return this.#failure(
            new DylinkInitializationError(
              new Error("Worker publication abort returned before owner rollback completed", {
                cause: error,
              }),
            ),
          );
        this.#error = error.message;
        return this.#word(0n);
      }
      if (committed && !this.#options.isControlFlow(error))
        return this.#failure(
          error instanceof DylinkInitializationError ? error : new DylinkInitializationError(error),
        );
      if (
        !committed &&
        scopedPublicationOpen &&
        publicationScope &&
        !this.#options.isControlFlow(error)
      ) {
        try {
          if (publicationScope.rollback.phase === "open") {
            publicationScope.rollback.token.restore();
            publicationScope.rollback.token.release();
          }
        } catch (cleanup) {
          return this.#failure(cleanup);
        }
        return this.#failure(error);
      }
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
    if (this.#queryBlockedFailure()) return this.#word(0n);
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
      const address = this.#options.replay
        ? this.#stableQueryAddress(symbol)
        : this.#address(symbol);
      return this.#word(address);
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
    this.#trackWorkerPublicationAllocation(pointer);
    const target = memory_bytes(this.#options.memory, pointer, encoded.length);
    if (!target)
      throw new DylinkInitializationError(new Error("invalid dynamic symbol name backing"));
    target.set(encoded);
    this.#addressNames.set(name, address);
    this.#touchWorkerGraph();
    return address;
  }
  address(pointer: WasmAddress, info: WasmAddress): number {
    if (this.#queryBlockedFailure()) return 0;
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
    if (this.#queryBlockedFailure()) return 0;
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
