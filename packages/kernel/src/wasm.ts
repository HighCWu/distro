// SPDX-License-Identifier: MIT

import { platform } from "./platform.ts";

export interface Instance extends WebAssembly.Instance {
  exports: {
    __indirect_function_table: WebAssembly.Table;
    boot(): void;
    trigger_irq(irq: number): void;
    syscall(
      nr: WasmAddress,
      arg0: WasmAddress,
      arg1: WasmAddress,
      arg2: WasmAddress,
      arg3: WasmAddress,
      arg4: WasmAddress,
      arg5: WasmAddress,
    ): WasmAddress;
    get_thread_area(): WasmAddress;
    copy_siginfo(to: WasmAddress): number;
    clear_siginfo(): void;
  };
}

export interface UserContext {
  module: WebAssembly.Module;
  memory: WebAssembly.Memory;
  address: WasmAddressType;
  // The JS API cannot recover a memory's maximum after construction.
  maximum_pages: number;
}

export type WasmAddressType = "i32" | "i64";
export type WasmAddress = number | bigint;

export interface WasmMemoryDescriptor extends Omit<
  WebAssembly.MemoryDescriptor,
  "initial" | "maximum"
> {
  initial: number | bigint;
  maximum?: number | bigint;
  address?: WasmAddressType;
}

/** Converts a Wasm scalar to JavaScript without silently losing integer bits. */
export function wasm_value_to_number(value: WasmAddress, name = "Wasm value"): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(number) || BigInt(number) !== BigInt(value)) {
    throw new RangeError(`${name} is outside JavaScript's safe integer range`);
  }
  return number;
}

/** Converts a Wasm address or size to the range accepted by JavaScript buffers. */
export function wasm_address_to_number(value: WasmAddress, name = "Wasm address"): number {
  const number = wasm_value_to_number(value, name);
  if (number < 0) throw new RangeError(`${name} is negative`);
  return number;
}

/** Converts a JavaScript buffer offset back to the module's pointer width. */
export function wasm_address_from_number(value: number, address: WasmAddressType): WasmAddress {
  const number = wasm_address_to_number(value);
  return address === "i64" ? BigInt(number) : number;
}

/** Looks up an entry without narrowing a table64 index to a JavaScript number. */
export function wasm_table_get(table: WebAssembly.Table, index: WasmAddress): CallableFunction | null {
  const get = table.get as unknown as (index: WasmAddress) => CallableFunction | null;
  return get.call(table, index);
}

export function refresh_memory(memory: WebAssembly.Memory, address: WasmAddressType): void {
  const grow = memory.grow as unknown as (delta: number | bigint) => number | bigint;
  grow.call(memory, address === "i64" ? 0n : 0);
}

const supported_user_module_imports = new Set([
  "env\0memory\0memory",
  "linux\0syscall\0function",
  "linux\0get_thread_area\0function",
  "linux\0copy_siginfo\0function",
]);

/** Whether every import can be supplied when a userspace module is instantiated. */
export function user_module_imports_supported(module: WebAssembly.Module): boolean {
  return WebAssembly.Module.imports(module).every(({ module, name, kind }) =>
    supported_user_module_imports.has(`${module}\0${name}\0${kind}`),
  );
}

/**
 * Allocates a shared memory, halving the maximum whenever the engine refuses
 * to reserve that much address space, degrading as far as the initial size.
 */
export function allocate_shared_memory(
  initial_pages: number,
  preferred_maximum_pages: number,
  allocate: (descriptor: WasmMemoryDescriptor) => WebAssembly.Memory = (descriptor) =>
    new WebAssembly.Memory(descriptor as unknown as WebAssembly.MemoryDescriptor),
  address: WasmAddressType = "i32",
): { memory: WebAssembly.Memory; address: WasmAddressType; maximum_pages: number } {
  let maximum_pages = preferred_maximum_pages;
  for (;;) {
    try {
      const initial = wasm_address_from_number(initial_pages, address);
      const maximum = wasm_address_from_number(maximum_pages, address);
      return {
        memory: allocate({
          initial,
          maximum,
          shared: true,
          address,
        }),
        address,
        maximum_pages,
      };
    } catch (error) {
      const smaller_maximum = Math.max(initial_pages, Math.floor(maximum_pages / 2));
      if (!(error instanceof RangeError) || smaller_maximum >= maximum_pages) {
        throw error;
      }
      maximum_pages = smaller_maximum;
    }
  }
}

/*
 * Read memory.buffer immediately before constructing a view so growth in
 * another worker is visible. Turn invalid bounds and host exceptions into an
 * ordinary failure result for kernel copy helpers.
 *
 * Omitting length returns the remainder of the current memory. Fork uses this
 * to derive the child's initial page count and bytes from the same view.
 */
export function memory_bytes(
  memory: WebAssembly.Memory,
  address_value: WasmAddress,
  length_value?: WasmAddress,
): Uint8Array<ArrayBufferLike> | null {
  try {
    const address = wasm_address_to_number(address_value);
    const buffer = memory.buffer;
    const view_length =
      length_value === undefined
        ? buffer.byteLength - address
        : wasm_address_to_number(length_value, "Wasm length");
    if (
      !Number.isSafeInteger(address) ||
      !Number.isSafeInteger(view_length) ||
      address < 0 ||
      view_length < 0 ||
      view_length > buffer.byteLength ||
      address > buffer.byteLength - view_length
    ) {
      return null;
    }
    return new Uint8Array(buffer, address, view_length);
  } catch {
    return null;
  }
}

const WASM_USER_MEMORY_NONE = 0;
const WASM_USER_MEMORY_SHARE = 1;
const WASM_USER_MEMORY_COPY = 2;

/** Values for the kernel.terminate_machine guest/host ABI. */
export const MachineTerminationReason = {
  Clean: 0,
  Panic: 1,
} as const;

/** Values for the kernel.terminate_machine guest/host ABI. */
export type MachineTerminationReason =
  (typeof MachineTerminationReason)[keyof typeof MachineTerminationReason];

export interface Imports {
  env: { memory: WebAssembly.Memory };
  boot: {
    get_devicetree(buf: WasmAddress, size: WasmAddress): WasmAddress;
    get_initramfs(buf: WasmAddress, size: WasmAddress): number;
  };
  kernel: {
    breakpoint(): void;
    halt_worker(): void;
    /** Reports that the whole machine ended, rather than only this worker. */
    terminate_machine(reason: MachineTerminationReason): void;
    boot_console_write(msg: WasmAddress, len: WasmAddress): void;
    boot_console_close(): void;
    return_address(_level: number): WasmAddress;
    /** Unix time in nanoseconds, monotonically advancing during this session. */
    get_now_nsec(): bigint;
    get_stacktrace(buf: WasmAddress, size: WasmAddress): void;
    spawn_worker(
      fn: WasmAddress,
      arg: WasmAddress,
      comm: WasmAddress,
      comm_len: WasmAddress,
      user_memory: number,
    ): number;
    run_on_main(fn: WasmAddress, arg: WasmAddress): void;
  };
  user: {
    compile_begin(size: number): number;
    compile_write(buf: WasmAddress, offset: number, size: number): number;
    compile_end(maximum_memory_pages: number): number;
    compile_abort(): void;
    instantiate(fresh_memory: number): void;
    call(): void;
    switch_entry(fn: number, arg: number): void;
    call_signal_handler(fn: number, sig: number): void;
    call_siginfo_handler(
      trampoline: number,
      fn: number,
      sig: number,
      code: number,
      pid: number,
      uid: number,
      value: number,
      timerid: number,
      overrun: number,
    ): void;
    read(to: WasmAddress, from: WasmAddress, n: WasmAddress): number;
    write(to: WasmAddress, from: WasmAddress, n: WasmAddress): number;
    write_zeroes(to: WasmAddress, n: WasmAddress): number;
    futex_atomic_op(oldval: WasmAddress, uaddr: WasmAddress, op: number, oparg: number): number;
    futex_atomic_cmpxchg(
      oldval: WasmAddress,
      uaddr: WasmAddress,
      expected: number,
      replacement: number,
    ): number;
  };
  virtio: {
    set_features(dev: number, features: bigint): void;

    setup(dev: number, config_irq: number, config_addr: WasmAddress, config_len: number): void;
    reset(dev: number): void;

    enable_vring(dev: number, vq: number, size: number, desc_addr: WasmAddress, irq: number): void;
    disable_vring(dev: number, vq: number): void;

    notify(dev: number, vq: number): void;
  };
}

export const HALT_KERNEL = Symbol("halt kernel");

export function kernel_imports({
  address,
  is_worker,
  memory,
  spawn_worker,
  boot_console_write,
  boot_console_close,
  terminate_machine,
  run_on_main,
  get_user_context,
  worker_exit,
}: {
  address: WasmAddressType;
  is_worker: boolean;
  memory: WebAssembly.Memory;
  spawn_worker: (
    fn: WasmAddress,
    arg: WasmAddress,
    name: string,
    user: UserContext | null,
    copy_user_memory: boolean,
  ) => number;
  boot_console_write: (message: ArrayBuffer) => void;
  boot_console_close: () => void;
  terminate_machine: (reason: MachineTerminationReason) => void;
  run_on_main: (fn: WasmAddress, arg: WasmAddress) => void;
  get_user_context: () => UserContext | null;
  /** Reports that this worker's kernel thread halted and the worker is closing. */
  worker_exit: () => void;
}): Imports["kernel"] {
  return {
    breakpoint: () => {
      debugger;
    },
    halt_worker: () => {
      if (!is_worker) throw new Error("Halt called in main thread");
      // Messages posted after platform.quit() are not guaranteed to arrive.
      worker_exit();
      platform.quit();
      throw HALT_KERNEL;
    },
    terminate_machine: (reason) => {
      if (!is_worker) {
        throw new Error("Machine termination called in main thread");
      }
      terminate_machine(reason);
      throw HALT_KERNEL;
    },

    boot_console_write: (msg, len) => {
      const offset = wasm_address_to_number(msg);
      const length = wasm_address_to_number(len, "console message length");
      boot_console_write(new Uint8Array(memory.buffer, offset, length).slice().buffer);
    },
    boot_console_close,

    return_address: (_level) => {
      return wasm_address_from_number(0, address);
    },

    get_now_nsec: () => {
      /*
        The more straightforward way to do this is
        `BigInt(Math.round(performance.now() * 1_000_000))`.
        Below is semantically identical but has less floating point
        inaccuracy.
        `performance.now()` has 5μs precision in the browser.
        In server runtimes it has full nanosecond precision, but this code
        rounds to the same 5μs precision.
      */
      return BigInt(Math.round((performance.now() + performance.timeOrigin) * 200)) * 5000n;
    },

    get_stacktrace: (buf, size) => {
      const offset = wasm_address_to_number(buf);
      const capacity = wasm_address_to_number(size, "stack trace capacity");
      // 5 lines: strip Error, strip 4 common lines of stack
      const trace = new TextEncoder().encode(new Error().stack?.split("\n").slice(5).join("\n"));
      if (trace.byteLength > capacity && capacity >= 3) {
        /// 46 = "."
        trace[capacity - 1] = 46;
        trace[capacity - 2] = 46;
        trace[capacity - 3] = 46;
      }
      new Uint8Array(memory.buffer).set(trace.subarray(0, capacity), offset);
    },

    spawn_worker: (fn, arg, comm, comm_len, user_memory) => {
      const comm_address = wasm_address_to_number(comm);
      const comm_length = wasm_address_to_number(comm_len, "worker name length");
      const name = new TextDecoder().decode(
        new Uint8Array(memory.buffer, comm_address, comm_length).slice(), // copy to transfer to non-shared backing
      );
      let user: UserContext | null = null;
      let copy_user_memory = false;
      if (user_memory !== WASM_USER_MEMORY_NONE) {
        const context = get_user_context();
        if (!context) return -22; // invalid argument

        switch (user_memory) {
          case WASM_USER_MEMORY_SHARE:
            user = context;
            break;
          case WASM_USER_MEMORY_COPY:
            user = context;
            copy_user_memory = true;
            break;
          default:
            return -22; // invalid argument
        }
      }
      return spawn_worker(fn, arg, name, user, copy_user_memory);
    },

    run_on_main,
  };
}
