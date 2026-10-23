// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { kernel_imports, type WasmAddressType } from "../src/wasm.ts";
import { grown_memory } from "./fixtures/grown-memory.ts";

function setup(memory: WebAssembly.Memory, address: WasmAddressType) {
  const messages: Uint8Array[] = [],
    names: string[] = [];
  const api = kernel_imports({
    address,
    memory,
    is_worker: true,
    spawn_worker: (_fn, _arg, name) => {
      names.push(name);
      return 23;
    },
    boot_console_write: (message) => messages.push(new Uint8Array(message)),
    boot_console_close: () => {},
    terminate_machine: () => {},
    run_on_main: () => {},
    get_user_context: () => null,
    worker_exit: () => {},
  });
  return { api, messages, names };
}

for (const address of ["i32", "i64"] as const) {
  const p = (n: number) => (address === "i64" ? BigInt(n) : n);
  test(`${address}: kernel name, console and trace imports refresh stale shared ranges`, () => {
    const fixture = grown_memory(address);
    const live = new Uint8Array(fixture.live());
    const encoded = new TextEncoder().encode("worker-é");
    live.set(encoded, 90000);
    const { api, messages, names } = setup(fixture.memory, address);
    api.boot_console_write(p(90000), p(encoded.length));
    assert.deepEqual(messages[0], encoded);
    live[90000] = 0;
    assert.deepEqual(messages[0], encoded, "console retains an owned snapshot");
    live.set(encoded, 90000);
    fixture.stale();
    assert.equal(api.spawn_worker(p(5), p(6), p(90000), p(encoded.length), 0), 23);
    assert.deepEqual(names, ["worker-é"]);
    fixture.stale();
    live.fill(0xa5, 89999, 90017);
    api.get_stacktrace(p(90000), p(16));
    assert.ok(live.slice(90000, 90016).includes(0));
    assert.equal(live[89999], 0xa5);
    assert.equal(live[90016], 0xa5);
    assert.equal(fixture.calls.length, 3);
    assert.equal(fixture.live().byteLength, 131072);
    fixture.stale();
    fixture.disable();
    const before = live.slice();
    assert.throws(() => api.spawn_worker(p(5), p(6), p(90000), p(4), 0), RangeError);
    assert.throws(() => api.boot_console_write(p(90000), p(4)), RangeError);
    assert.throws(() => api.get_stacktrace(p(90000), p(16)), RangeError);
    assert.deepEqual(names, ["worker-é"]);
    assert.equal(messages.length, 1);
    assert.deepEqual(live, before);
  });
}

test("kernel i32 imports decode signed high pointers before accessing a buffer", () => {
  // Avoid allocating GiBs: reaching this getter proves decoding succeeded,
  // but does not claim a real high-address copy or a browser result.
  const reached = new Error("buffer access reached");
  const memory = {
    get buffer() {
      throw reached;
    },
  } as unknown as WebAssembly.Memory;
  const { api } = setup(memory, "i32");
  for (const invoke of [
    () => api.boot_console_write(-0x80000000, 1),
    () => api.spawn_worker(1, 0, -0x80000000, 1, 0),
    () => api.get_stacktrace(-0x80000000, 1),
  ])
    assert.throws(invoke, (error) => error === reached);
});
