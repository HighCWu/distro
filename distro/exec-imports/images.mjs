// SPDX-License-Identifier: MIT
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const unsigned = (n) => (n < 128 ? [n] : [(n & 127) | 128, ...unsigned(Math.floor(n / 128))]);
const signed = (n) => (n < 64 ? [n] : [(n & 127) | 128, ...signed(Math.floor(n / 128))]);
const string = (s) => {
  const bytes = [...new TextEncoder().encode(s)];
  return [...unsigned(bytes.length), ...bytes];
};
const section = (id, bytes) => [id, ...unsigned(bytes.length), ...bytes];

/** Engine-valid executables varying one host import contract at a time. */
export function image(bits, mode, withStart = false) {
  if (
    ![32, 64].includes(bits) ||
    ![
      "good",
      "immutable",
      "width",
      "float",
      "syscall-width",
      "syscall-result",
      "syscall-arity",
      "poll-result",
      "entry-missing",
      "entry-argument",
      "entry-result",
      "entry-kind",
    ].includes(mode)
  )
    throw new Error("expected pointer width and explicit fixture mode");
  const word = bits === 64 ? 0x7e : 0x7f,
    constant = bits === 64 ? 0x42 : 0x41;
  const value = mode === "width" ? (word === 0x7e ? 0x7f : 0x7e) : mode === "float" ? 0x7c : word;
  const syscallWord = mode === "syscall-width" ? (word === 0x7e ? 0x7f : 0x7e) : word;
  const syscallResult = mode === "syscall-result" ? (word === 0x7e ? 0x7f : 0x7e) : word;
  const registers = mode === "syscall-arity" ? 6 : 7;
  const syscallConstant = syscallWord === 0x7e ? 0x42 : 0x41;
  const abi = [0, 0x41, 2, 0x0b];
  const start = [
    0,
    syscallConstant,
    ...signed(94),
    ...Array.from({ length: registers - 1 }, () => [syscallConstant, 0]).flat(),
    0x10,
    1,
    0x1a,
    0x00,
    0x0b,
  ];
  return new Uint8Array([
    0,
    97,
    115,
    109,
    1,
    0,
    0,
    0,
    ...section(1, [
      5,
      0x60,
      0,
      1,
      0x7f,
      0x60,
      registers,
      ...Array(registers).fill(syscallWord),
      1,
      syscallResult,
      0x60,
      ...(mode === "entry-argument" ? [1, word] : [0]),
      ...(mode === "entry-result" ? [1, word] : [0]),
      0x60,
      0,
      1,
      mode === "poll-result" ? 0x7c : 0x7f,
      // Unrelated reference signatures must not inherit numeric-only dynamic restrictions.
      0x60,
      1,
      0x6f,
      1,
      0x6f,
    ]),
    ...section(2, [
      4,
      ...string("env"),
      ...string("memory"),
      2,
      bits === 64 ? 7 : 3,
      2,
      ...unsigned(bits === 64 ? 262144 : 65536),
      ...string("linux_user_poll_v2"),
      ...string("checkpoint"),
      0,
      3,
      ...string("linux"),
      ...string("syscall"),
      0,
      1,
      ...string("linux_user_poll_v2"),
      ...string("thread_pointer"),
      3,
      value,
      mode === "immutable" ? 0 : 1,
    ]),
    ...section(3, [2, 0, 2]),
    ...section(6, [2, word, 1, constant, 0, 0x0b, word, 1, constant, ...signed(65536), 0x0b]),
    ...section(7, [
      mode === "entry-missing" ? 3 : 4,
      ...string("__wasm_user_poll_abi"),
      0,
      2,
      ...(mode === "entry-missing"
        ? []
        : [...string("_start"), mode === "entry-kind" ? 3 : 0, mode === "entry-kind" ? 1 : 3]),
      ...string("__tls_base"),
      3,
      1,
      ...string("__stack_pointer"),
      3,
      2,
    ]),
    ...(withStart ? section(8, [3]) : []),
    ...section(10, [2, ...unsigned(abi.length), ...abi, ...unsigned(start.length), ...start]),
  ]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const bits = Number(process.argv[2]),
    output = process.argv[3];
  mkdirSync(output, { recursive: true });
  for (const mode of [
    "good",
    "immutable",
    "width",
    "float",
    "syscall-width",
    "syscall-result",
    "syscall-arity",
    "poll-result",
    "entry-missing",
    "entry-argument",
    "entry-result",
    "entry-kind",
  ])
    writeFileSync(`${output}/${mode}.wasm`, image(bits, mode), { mode: 0o755 });
}
