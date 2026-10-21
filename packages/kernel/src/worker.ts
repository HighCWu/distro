// SPDX-License-Identifier: MIT

import { listen_endpoint, post_endpoint } from "./endpoint.ts";
import { platform } from "./platform.ts";
import {
  create_fork_profile,
  new_fork_profile_request,
  type ForkProfile,
  type ForkProfileRequest,
} from "./fork-profile.ts";
import {
  fork_signal_test,
  fork_resume_signal_test,
  fork_child_signal_test,
  inject_saved_fork_signal,
  inject_resume_fork_signal,
  inject_child_fork_signal,
} from "./fork-signal-test.ts";
import {
  inject_copy_fault,
  type CopyFault,
  copy_status_words,
  pause_copy_publication,
  acknowledge_copy_timeout,
  join_copy_timeout,
  copy_fault_test,
  require_copy_wait_progress,
} from "./copy-fault.ts";
import {
  user_mmap,
  user_mmap_fixed,
  user_mremap,
  user_mremap_fixed,
  user_msync,
  user_madvise,
} from "./user-mmap.ts";
import { FileMmapCopy } from "./file-mmap-copy.ts";
import {
  read_signal_stack_pointer,
  call_on_signal_stack,
  call_kernel_entry,
} from "./signal-stack.ts";
import { write_exec_image } from "./exec-image.ts";
import {
  ForkContinuation,
  dispatch_fork_syscall,
  type CloneSyscallLayout,
  fork_continuation_exports_supported,
  uses_fork_continuation,
  resume_fork_parent,
  resume_fork_child,
} from "./fork-continuation.ts";
import {
  settle_user_copy,
  USER_COPY_COMPLETE,
  USER_COPY_NO_MEMORY,
  user_copy_failed,
  type UserCopyStatus,
  wait_user_copy,
} from "./user-copy.ts";
import { assert } from "./util.ts";
import {
  read_user_memory,
  write_user_memory,
  clear_user_memory,
  user_atomic_word,
} from "./user-memory.ts";
import { read_wasm_memories, user_memory_import } from "./wasm_binary.ts";
import {
  allocate_shared_memory,
  HALT_KERNEL,
  type Imports,
  type Instance,
  kernel_imports,
  type MachineTerminationReason,
  memory_bytes,
  refresh_memory,
  user_module_imports_supported,
  type WasmAddress,
  type WasmAddressType,
  wasm_pointer_to_number,
  wasm_size_to_number,
  wasm_table_get,
  type UserContext,
} from "./wasm.ts";

export interface InitMessage {
  type: "init";
  fn: WasmAddress;
  arg: WasmAddress;
  vmlinux: WebAssembly.Module;
  memory: WebAssembly.Memory;
  kernel_address: WasmAddressType;
  user: UserContext | null;
  /** One-shot user-memory copy result: 0 pending, 1 complete, negative errno. */
  user_copy_status: UserCopyStatus | null;
  copy_fault?: CopyFault;
  fork_profile?: ForkProfileRequest;
}
export interface ForwardedInitMessage {
  type: "forwarded_init";
  port: MessagePort;
  user_copy_status: UserCopyStatus | null;
  copy_fault?: CopyFault;
  fork_profile?: ForkProfileRequest;
}
export type WorkerMessage =
  | {
      type: "spawn_worker";
      name: string;
      port: MessagePort;
      user_copy_status: UserCopyStatus | null;
      fork_profile?: ForkProfileRequest;
    }
  | { type: "boot_console_write"; message: ArrayBuffer }
  | { type: "fork_profile_started" }
  | { type: "fork_profile_online" | "fork_profile_main_turn" }
  | { type: "fork_profile_module_ready"; module_ns: number }
  | { type: "fork_profile_init_posted"; queued_ns: number; post_ns: number }
  | { type: "fork_profile_record"; line: string }
  | { type: "boot_console_close" }
  | { type: "terminate_machine"; reason: MachineTerminationReason }
  | { type: "run_on_main"; fn: WasmAddress; arg: WasmAddress }
  | { type: "worker_exit" };

const unavailable = () => {
  throw new Error("not available on worker thread");
};

const endpoint = platform.worker_endpoint();
const postMessage = (message: WorkerMessage, transfer?: Transferable[]) =>
  post_endpoint(endpoint, message, transfer);
const profile_output = (line: string) => postMessage({ type: "fork_profile_record", line });

function user_imports({
  kernel_memory,
  kernel_address,
  get_kernel_instance,
  parent_user: parent,
  profile,
}: {
  kernel_memory: WebAssembly.Memory;
  kernel_address: WasmAddressType;
  get_kernel_instance: () => Instance;
  parent_user: UserContext | null;
  profile?: ForkProfile;
}): {
  context: UserContext | null;
  prepare(): void;
  imports: Imports["user"];
  imports_v2: Imports["user_v2"];
  imports_signal_v1: Imports["user_signal_v1"];
  imports_mmap_init_v1: Imports["user_mmap_init_v1"];
} {
  const HALT_USER = Symbol("halt user");

  let context: UserContext | null = parent;
  let instance: WebAssembly.Instance | null = null;
  let pending_module_bytes: Uint8Array<ArrayBuffer> | null = null;
  let pending: UserContext | null = null;
  let fork: ForkContinuation | null = null;
  let signal_depth = 0;
  // One slot per nested SA_SIGINFO callback; null means its trampoline has
  // not requested the active signal payload yet.
  const siginfo_copy_results: (number | null)[] = [];
  const mmap_copy = new FileMmapCopy(kernel_memory, kernel_address);

  function write_kernel_u32(addr: WasmAddress, value: number): boolean {
    let bytes;
    try {
      bytes = memory_bytes(
        kernel_memory,
        wasm_pointer_to_number(addr),
        Uint32Array.BYTES_PER_ELEMENT,
      );
    } catch {
      return false;
    }
    if (!bytes) return false;

    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(0, value, true);
    return true;
  }

  function call_start(): void {
    assert(instance);
    const { _start } = instance.exports;
    assert(typeof _start === "function", "_start not found");
    _start();
    if (fork?.unwinding()) return;
    throw new Error("_start reached the end without exiting");
  }
  let call_entry = call_start;

  function create_instance(context: UserContext): WebAssembly.Instance {
    const kernel_instance = get_kernel_instance();
    const syscall =
      (layout: CloneSyscallLayout) =>
      (
        nr: WasmAddress,
        arg0: WasmAddress,
        arg1: WasmAddress,
        arg2: WasmAddress,
        arg3: WasmAddress,
        arg4: WasmAddress,
        arg5: WasmAddress,
      ) => {
        const original_instance = instance;
        const invoke = () =>
          call_kernel_entry(kernel_instance.exports, kernel_address, () =>
            kernel_instance.exports.syscall(nr, arg0, arg1, arg2, arg3, arg4, arg5),
          );
        const ret = dispatch_fork_syscall(
          fork,
          nr,
          [arg0, arg1, arg2, arg3, arg4, arg5],
          signal_depth === 0 && call_entry === call_start,
          invoke,
          layout,
        );
        if (instance !== original_instance) {
          call_entry = call_start;
          throw HALT_USER;
        }
        return ret;
      };
    return new WebAssembly.Instance(context.module, {
      env: { memory: context.memory },
      linux_fork_v1: {
        checkpoint: (descriptor: WasmAddress) =>
          fork?.checkpoint(descriptor, signal_depth === 0 && call_entry === call_start) ?? -38,
      },
      linux_mmap_init_v1: {
        copy: (to: WasmAddress, length: WasmAddress) => mmap_copy.copy(context.memory, to, length),
      },
      linux: {
        syscall: syscall("callback-v1"),
        syscall_v2: syscall("flags-v2"),
        get_thread_area: () => {
          const invoke = () => kernel_instance.exports.get_thread_area();
          return fork ? fork.kernelCall(invoke) : invoke();
        },
        copy_siginfo: (to: WasmAddress) => {
          const invoke = () => kernel_instance.exports.copy_siginfo(to);
          const result = fork ? fork.kernelCall(invoke) : invoke();
          const current = siginfo_copy_results.length - 1;
          if (current >= 0) siginfo_copy_results[current] = result;
          return result;
        },
      },
      linux_signal_v1: {
        finish(stack: WasmAddress, mask: WasmAddress) {
          const invoke = () => kernel_instance.exports.finish_signal_frame?.(stack, mask) ?? -95;
          const result = fork ? fork.kernelCall(invoke) : invoke();
          const current = siginfo_copy_results.length - 1;
          if (current >= 0 && result < 0 && result !== -95) siginfo_copy_results[current] = result;
          return result;
        },
        frame(stack: WasmAddress, mask: WasmAddress) {
          const invoke = () => kernel_instance.exports.copy_signal_frame?.(stack, mask) ?? -95;
          const result = fork ? fork.kernelCall(invoke) : invoke();
          const current = siginfo_copy_results.length - 1;
          if (current >= 0 && result < 0 && result !== -95) siginfo_copy_results[current] = result;
          return result;
        },
      },
    });
  }

  function instantiate(fresh_memory: boolean): void {
    if (fresh_memory) {
      assert(pending);
      context = pending;
      pending = null;
    }

    assert(context);
    instance = create_instance(context);
    fork = uses_fork_continuation(context.module)
      ? new ForkContinuation(
          instance,
          context.memory,
          context.address,
          profile ? () => profile.childRewound() : undefined,
          get_kernel_instance().exports.fork_worker_abort_abi?.() === 1,
        )
      : null;
  }

  const result: ReturnType<typeof user_imports> = {
    get context() {
      return context;
    },
    prepare() {
      if (parent) instantiate(false);
    },
    imports: {
      // program management:
      compile_begin(size) {
        pending_module_bytes = null;
        pending = null;
        try {
          pending_module_bytes = new Uint8Array(size >>> 0);
          return 0;
        } catch {
          return -12; // out of memory
        }
      },
      compile_write(buf, offset, size) {
        return write_exec_image(pending_module_bytes, kernel_memory, buf, offset, size);
      },
      compile_end(maximum_memory_pages) {
        const bytes = pending_module_bytes;
        pending_module_bytes = null;
        if (!bytes) return -22; // invalid argument

        const rlimit_pages = maximum_memory_pages >>> 0;
        let module: WebAssembly.Module;
        let minimum: number;
        let maximum: number;
        try {
          const memories = read_wasm_memories(bytes);
          const memory_import = user_memory_import(memories, kernel_address);
          if (!memory_import) return -8; // exec format error

          module = new WebAssembly.Module(bytes);
          if (
            !user_module_imports_supported(module) ||
            !fork_continuation_exports_supported(module)
          ) {
            return -8; // exec format error
          }

          minimum = Number(memory_import.type.minimum);
          maximum = Math.min(Number(memory_import.type.maximum), rlimit_pages);
        } catch {
          return -8; // exec format error
        }

        if (maximum < minimum) return -12; // out of memory

        let allocated: ReturnType<typeof allocate_shared_memory>;
        try {
          allocated = allocate_shared_memory(minimum, maximum, undefined, kernel_address);
        } catch {
          return -12; // out of memory
        }

        const next_context = { module, ...allocated };
        pending = next_context;
        return 0;
      },
      compile_abort() {
        pending_module_bytes = null;
        pending = null;
      },
      instantiate(fresh_memory) {
        instantiate(Boolean(fresh_memory));
      },
      call() {
        for (;;) {
          try {
            call_entry();
            if (fork?.unwinding()) {
              assert(context);
              const continuation = fork;
              resume_fork_parent(
                context,
                continuation,
                fork_signal_test
                  ? () =>
                      continuation.kernelCall(() =>
                        inject_saved_fork_signal(
                          get_kernel_instance().exports.syscall,
                          kernel_address,
                        ),
                      )
                  : undefined,
                fork_resume_signal_test
                  ? () =>
                      continuation.kernelCall(() =>
                        inject_resume_fork_signal(
                          get_kernel_instance().exports.syscall,
                          kernel_address,
                        ),
                      )
                  : undefined,
              );
            }
          } catch (error) {
            if (error === HALT_USER) continue;
            if (error === HALT_KERNEL) throw error;
            console.error("error running user module:", error);
            return;
          }
        }
      },
      switch_entry(fn, arg) {
        // This is called if this thread was created by a clone call,
        // so its entrypoint is a user-specified function.
        // The worker prepares an instance sharing the parent's user context
        // before the kernel enters this callback.

        assert(parent);

        if (context?.fork_continuation) {
          const snapshot = context.fork_continuation;
          assert(
            fork && snapshot.entry === fn && (arg === 0 || arg === 0n),
            "invalid fork child entry",
          );
          if (fork_child_signal_test) {
            const continuation = fork;
            // switch_entry is still a kernel startup callback. Defer all test
            // syscalls until the regular user.call boundary, before rewinding.
            call_entry = () => {
              assert(context && context.fork_continuation === snapshot);
              resume_fork_child(context, continuation, () =>
                continuation.kernelCall(() =>
                  inject_child_fork_signal(get_kernel_instance().exports.syscall, kernel_address),
                ),
              );
              call_entry = call_start;
              call_start();
            };
            return;
          }
          if (profile) profile.prepareChild(() => fork!.resumeChild(snapshot));
          else fork.resumeChild(snapshot);
          delete context.fork_continuation;
          call_entry = call_start;
          return;
        }

        call_entry = () => {
          assert(instance);

          const { __indirect_function_table } = instance.exports;
          assert(__indirect_function_table instanceof WebAssembly.Table, "Invalid function table");

          const f = wasm_table_get(__indirect_function_table, fn);
          assert(typeof f === "function" && f.length === 1, "Invalid function signature");

          f(arg);

          // throw new Error("thread entrypoint reached the end without exiting");
          console.warn("thread entrypoint reached the end without exiting");
        };
      },

      // signal handling:
      call_signal_handler(fn, sig) {
        assert(instance);

        const { __indirect_function_table } = instance.exports;
        assert(__indirect_function_table instanceof WebAssembly.Table, "Invalid function table");

        const f = wasm_table_get(__indirect_function_table, fn);
        assert(typeof f === "function" && f.length === 1, "Invalid function signature");

        signal_depth++;
        try {
          f(sig);
        } finally {
          signal_depth--;
          get_kernel_instance().exports.clear_siginfo();
        }
      },
      call_siginfo_handler(trampoline, fn, sig) {
        assert(instance);

        const { __indirect_function_table } = instance.exports;
        assert(__indirect_function_table instanceof WebAssembly.Table, "Invalid function table");

        const f = wasm_table_get(__indirect_function_table, trampoline);
        assert(typeof f === "function" && f.length === 2, "Invalid siginfo trampoline");

        siginfo_copy_results.push(null);
        signal_depth++;
        try {
          f(fn, sig);
          return siginfo_copy_results.at(-1) ?? -22;
        } finally {
          signal_depth--;
          // Non-local exits can unwind the kernel callback before its C cleanup.
          try {
            get_kernel_instance().exports.clear_siginfo();
          } finally {
            siginfo_copy_results.pop();
          }
        }
      },

      // memory:
      read(to, from, n) {
        const length = wasm_size_to_number(n);
        if (!context) return length;
        return read_user_memory(kernel_memory, to, context.memory, from, length);
      },
      write(to, from, n) {
        const length = wasm_size_to_number(n);
        if (!context) return length;
        return write_user_memory(context.memory, to, kernel_memory, from, length);
      },
      write_zeroes(to, n) {
        const length = wasm_size_to_number(n);
        if (!context) return length;
        return clear_user_memory(context.memory, to, length);
      },
      futex_atomic_op(oldval, uaddr, op, oparg) {
        const word = context && user_atomic_word(context.memory, uaddr);
        if (!word) return -14; // bad address

        let old: number;
        switch (op) {
          case 0: // FUTEX_OP_SET
            old = Atomics.exchange(word, 0, oparg);
            break;
          case 1: // FUTEX_OP_ADD
            old = Atomics.add(word, 0, oparg);
            break;
          case 2: // FUTEX_OP_OR
            old = Atomics.or(word, 0, oparg);
            break;
          case 3: // FUTEX_OP_ANDN
            old = Atomics.and(word, 0, ~oparg);
            break;
          case 4: // FUTEX_OP_XOR
            old = Atomics.xor(word, 0, oparg);
            break;
          default:
            return -38; // function not implemented
        }

        return write_kernel_u32(oldval, old) ? 0 : -14; // bad address
      },
      futex_atomic_cmpxchg(oldval, uaddr, expected, replacement) {
        const word = context && user_atomic_word(context.memory, uaddr);
        if (!word) return -14; // bad address

        const old = Atomics.compareExchange(word, 0, expected, replacement);
        return write_kernel_u32(oldval, old) ? 0 : -14; // bad address
      },
      mmap(len) {
        assert(instance);
        const callback = instance.exports.__wasm_mmap;
        if (typeof callback !== "function") return kernel_address === "i64" ? -38n : -38;
        return callback(len) as WasmAddress;
      },
      munmap(addr, len) {
        assert(instance);
        const callback = instance.exports.__wasm_munmap;
        if (typeof callback !== "function") return kernel_address === "i64" ? -38n : -38;
        return callback(addr, len) as WasmAddress;
      },
    },
    imports_signal_v1: {
      stack_pointer(to) {
        if (!instance || !context) return -95;
        const raw = read_signal_stack_pointer(instance.exports, context.memory, context.address);
        if (raw === null) return -95;
        try {
          const value = wasm_pointer_to_number(raw);
          if (kernel_address === "i32" && value > 0xffffffff) return -75;
          const bytes = memory_bytes(
            kernel_memory,
            wasm_pointer_to_number(to),
            kernel_address === "i64" ? 8 : 4,
          );
          if (!bytes) return -14;
          const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
          if (kernel_address === "i64") view.setBigUint64(0, BigInt(value), true);
          else view.setUint32(0, value, true);
          return 0;
        } catch {
          return -14;
        }
      },
      call_handler(trampoline, fn, sig, sp, base, size, flags) {
        if (!instance || !context) return -95;
        return call_on_signal_stack(
          instance.exports,
          context.memory,
          context.address,
          sp,
          base,
          size,
          flags,
          () => {
            if (flags & 1) return result.imports.call_siginfo_handler(trampoline, fn, sig);
            result.imports.call_signal_handler(fn, sig);
            return 0;
          },
        );
      },
    },
    imports_v2: {
      mremap_fixed(addr, oldLen, newLen, newAddr) {
        assert(instance);
        return user_mremap_fixed(instance.exports, kernel_address, addr, oldLen, newLen, newAddr);
      },
      mmap_fixed(addr, len) {
        assert(instance);
        return user_mmap_fixed(instance.exports, kernel_address, addr, len);
      },
      madvise(addr, len, advice) {
        assert(instance);
        return user_madvise(instance.exports, kernel_address, addr, len, advice);
      },
      msync(addr, len, flags) {
        assert(instance);
        return user_msync(instance.exports, kernel_address, addr, len, flags);
      },
      mremap(addr, oldLen, newLen, flags) {
        assert(instance);
        return user_mremap(instance.exports, kernel_address, addr, oldLen, newLen, flags);
      },
      mmap(addr, len, prot, flags, fd, pgoff) {
        assert(instance);
        return user_mmap(instance.exports, kernel_address, addr, len, prot, flags, fd, pgoff);
      },
    },
    imports_mmap_init_v1: {
      capabilities() {
        assert(instance);
        return mmap_copy.capabilities(instance.exports);
      },
      map(rounded, source, length) {
        assert(instance);
        return mmap_copy.map(instance.exports, rounded, source, length);
      },
    },
  };
  return result;
}

function start({
  fn,
  arg,
  vmlinux,
  memory,
  kernel_address,
  user: initial_user_context,
  user_copy_status,
  copy_fault,
  fork_profile,
}: InitMessage) {
  const profile = create_fork_profile(fork_profile, profile_output);
  if (profile) postMessage({ type: "fork_profile_started" });
  const cancelled = () => {
    if (!user_copy_failed(user_copy_status)) return false;
    postMessage({ type: "worker_exit" });
    platform.quit();
    return true;
  };
  if (cancelled()) return;
  if (user_copy_status) inject_copy_fault(copy_fault, "initialize");
  // Refresh every WebAssembly.Memory received across a worker boundary
  // immediately, including any future additions to InitMessage. Chromium can
  // retain the fixed-length buffer wrapper captured before another isolate
  // grows it; grow(0) refreshes the wrapper before constructing any views.
  refresh_memory(memory, kernel_address);
  if (initial_user_context) {
    refresh_memory(initial_user_context.memory, initial_user_context.address);
  }

  let user_context = initial_user_context;
  if (user_copy_status) {
    assert(user_context);
    // fork.c permits COPY only for a single-user mm. The caller blocks until
    // publication or timeout; a timed-out copy must never be published. Allocate here so the
    // private backing store is owned by the destination isolate, not the
    // long-lived parent.
    try {
      inject_copy_fault(copy_fault, "allocate");
      const source = memory_bytes(user_context.memory, 0);
      if (!source) throw new RangeError("invalid source memory");
      const { maximum_pages, address } = user_context;
      const allocate = () =>
        allocate_shared_memory(source.byteLength / 0x10000, maximum_pages, undefined, address);
      const copied = profile ? profile.measure("allocate_ns", allocate) : allocate();
      const destination = memory_bytes(copied.memory, 0, source.byteLength);
      if (!destination) throw new RangeError("invalid destination memory");
      if (profile) profile.measure("copy_ns", () => destination.set(source));
      else destination.set(source);
      user_context = { ...user_context, ...copied };
    } catch {
      settle_user_copy(user_copy_status, USER_COPY_NO_MEMORY);
      postMessage({ type: "worker_exit" });
      platform.quit();
      return;
    }
  }

  if (cancelled()) return;
  const user = user_imports({
    kernel_memory: memory,
    kernel_address,
    get_kernel_instance: () => instance,
    parent_user: user_context,
    profile,
  });

  const imports = {
    env: { memory },
    boot: {
      get_devicetree: unavailable,
      get_initramfs: unavailable,
    },
    user: user.imports,
    user_v2: user.imports_v2,
    user_signal_v1: user.imports_signal_v1,
    user_mmap_init_v1: user.imports_mmap_init_v1,
    kernel: kernel_imports({
      address: kernel_address,
      is_worker: true,
      memory,
      spawn_worker(fn, arg, name, user, copy_user_memory): number {
        const direct = new MessageChannel();
        const user_copy_status = copy_user_memory
          ? new Int32Array(new SharedArrayBuffer(4 * copy_status_words()))
          : null;
        const fork_profile = copy_user_memory ? new_fork_profile_request() : undefined;
        const parent_profile = create_fork_profile(fork_profile, profile_output);
        postMessage(
          {
            type: "spawn_worker",
            name,
            port: direct.port1,
            user_copy_status,
            ...(fork_profile ? { fork_profile } : {}),
          },
          [direct.port1],
        );
        direct.port2.postMessage({
          type: "init",
          fn,
          arg,
          vmlinux,
          memory,
          kernel_address,
          user,
          user_copy_status,
          ...(fork_profile ? { fork_profile } : {}),
        } satisfies InitMessage);
        if (!user_copy_status) return 0;
        const schedule = instance.exports.copy_worker_wait;
        let scheduling_points = 0;
        const cooperate =
          schedule && copy_fault_test
            ? () => {
                schedule();
                scheduling_points++;
              }
            : schedule && parent_profile
              ? () =>
                  parent_profile.cooperate(
                    schedule,
                    () => Atomics.load(user_copy_status, 0) === USER_COPY_COMPLETE,
                  )
              : schedule;
        const result = parent_profile
          ? parent_profile.wait(() => wait_user_copy(user_copy_status, 30_000, cooperate))
          : wait_user_copy(user_copy_status, 30_000, cooperate);
        require_copy_wait_progress(user_copy_status, scheduling_points);
        join_copy_timeout(user_copy_status);
        if (result === USER_COPY_COMPLETE) parent_profile?.parentReady();
        return result === USER_COPY_COMPLETE ? 0 : result;
      },
      boot_console_write(message) {
        postMessage({ type: "boot_console_write", message });
      },
      boot_console_close() {
        postMessage({ type: "boot_console_close" });
      },
      terminate_machine(reason) {
        postMessage({ type: "terminate_machine", reason });
      },
      run_on_main(fn, arg) {
        postMessage({ type: "run_on_main", fn, arg });
      },
      get_user_context() {
        return user.context;
      },
      worker_exit() {
        postMessage({ type: "worker_exit" });
      },
    }),
    virtio: {
      set_features: unavailable,
      setup: unavailable,
      reset: unavailable,
      enable_vring: unavailable,
      disable_vring: unavailable,
      notify: unavailable,
    },
  } satisfies Imports;

  const instantiate_kernel = () => new WebAssembly.Instance(vmlinux, imports) as Instance;
  const instance = profile
    ? profile.measure("kernel_instance_ns", instantiate_kernel)
    : instantiate_kernel();
  if (profile) profile.measure("user_instance_ns", () => user.prepare());
  else user.prepare();
  if (user_copy_status) pause_copy_publication(copy_fault, user_copy_status);
  if (user_copy_status && !settle_user_copy(user_copy_status, USER_COPY_COMPLETE)) {
    acknowledge_copy_timeout(copy_fault, user_copy_status);
    postMessage({ type: "worker_exit" });
    platform.quit();
    return;
  }
  profile?.childReady();
  try {
    wasm_table_get(instance.exports.__indirect_function_table, fn)!(arg);
  } catch (error) {
    if (error === HALT_KERNEL) return;
    throw error;
  }
}

listen_endpoint(endpoint, {
  message(raw) {
    const message = raw as InitMessage | ForwardedInitMessage;

    // Initial workers receive InitMessage directly from the page. Workers
    // spawned by another worker receive their InitMessage over this port, which
    // works around a WebKit bug reclaiming shared Wasm memory across JS VMs.
    if (message.type === "forwarded_init") {
      message.port.onmessage = ({ data }) => {
        message.port.close();
        start({ ...(data as InitMessage), copy_fault: message.copy_fault });
      };
      message.port.start();
      return;
    }

    start(message);
  },
});
