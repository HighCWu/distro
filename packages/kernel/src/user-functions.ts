// SPDX-License-Identifier: MIT
import { read_wasm_function_import_probe } from "./wasm_binary.ts";

const leb = (n: number): number[] =>
  n < 128 ? [n] : [(n & 127) | 128, ...leb(Math.floor(n / 128))];
const string = (s: string) => {
  const b = [...new TextEncoder().encode(s)];
  return [...leb(b.length), ...b];
};
const section = (id: number, b: number[] | Uint8Array) => [id, ...leb(b.length), ...b];
const header = [0, 97, 115, 109, 1, 0, 0, 0];
const providers = new Map<string, WebAssembly.Imports>();

/** Only typed inert Wasm functions are supplied. Ordinary JS functions would
 * silently accept incompatible Wasm signatures and erase the ABI mismatch. */
function typed_providers(address: "i32" | "i64") {
  const cached = providers.get(address);
  if (cached) return cached;
  const w = address === "i64" ? 0x7e : 0x7f,
    i = 0x7f;
  const signatures: [string, string, number[], number | null][] = [
    ["linux", "syscall", Array(7).fill(w), w],
    ["linux", "syscall_v2", Array(7).fill(w), w],
    ["linux", "get_thread_area", [], w],
    ["linux", "copy_siginfo", [w], i],
    ["linux_signal_v1", "frame", [w, w], i],
    ["linux_signal_v1", "finish", [w, w], i],
    ["linux_signal_cancel_v1", "abi", [], i],
    ["linux_mmap_init_v1", "copy", [w, w], i],
    ["linux_fork_v1", "checkpoint", [w], i],
    ["linux_user_poll_v1", "checkpoint", [], i],
    ["linux_user_poll_v2", "checkpoint", [], i],
    ["linux_dlopen_v1", "abi", [], i],
    ["linux_dlopen_v1", "link_map_abi", [], i],
    ["linux_dlopen_v1", "open", [w, i], w],
    ["linux_dlopen_v1", "symbol", [w, w], w],
    ["linux_dlopen_v1", "valid", [w], i],
    ["linux_dlopen_v1", "error", [w, w], i],
    ["_execution", "_start", [], null],
  ];
  const code = signatures.flatMap(([, , , result]) => {
    const body = result === null ? [0, 0x0b] : [0, result === 0x7e ? 0x42 : 0x41, 0, 0x0b];
    return [...leb(body.length), ...body];
  });
  const module = new WebAssembly.Module(
    new Uint8Array([
      ...header,
      ...section(1, [
        signatures.length,
        ...signatures.flatMap(([, , args, result]) => [
          0x60,
          ...leb(args.length),
          ...args,
          ...(result === null ? [0] : [1, result]),
        ]),
      ]),
      ...section(3, [signatures.length, ...signatures.map((_, n) => n)]),
      ...section(7, [
        signatures.length,
        ...signatures.flatMap((_, n) => [...string(String(n)), 0, n]),
      ]),
      ...section(10, [signatures.length, ...code]),
    ]),
  );
  const functions = new WebAssembly.Instance(module).exports;
  const result: WebAssembly.Imports = Object.create(null);
  signatures.forEach(([module, name], n) => {
    const namespace = result[module] ?? (result[module] = Object.create(null));
    namespace[name] = functions[String(n)]!;
  });
  providers.set(address, result);
  return result;
}

/** Precommit admission only: never instantiate the user's executable. Copy its
 * type section verbatim and link a function-import-only module against inert
 * typed providers. No user function, start section, data or memory is present.
 * The engine checks parameter/result types, including same-arity mismatches. */
export function user_function_imports_supported(
  bytes: Uint8Array,
  address: "i32" | "i64",
  requireEntry = false,
) {
  const { types, functions, entryType } = read_wasm_function_import_probe(bytes);
  if (requireEntry) {
    if (entryType === undefined) return false;
    functions.push({ module: "_execution", name: "_start", typeIndex: entryType });
  }
  if (!functions.length) return true;
  const imports = functions.flatMap(({ module, name, typeIndex }) => [
    ...string(module),
    ...string(name),
    0,
    ...leb(typeIndex),
  ]);
  try {
    const probe = new WebAssembly.Module(
      new Uint8Array([
        ...header,
        ...section(1, types),
        ...section(2, [...leb(functions.length), ...imports]),
      ]),
    );
    new WebAssembly.Instance(probe, typed_providers(address));
    return true;
  } catch (error) {
    if (error instanceof WebAssembly.LinkError || error instanceof WebAssembly.CompileError)
      return false;
    throw error;
  }
}
