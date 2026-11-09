// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { create_dylink_call_wrapper } from "../src/dylink_call_wrapper.ts";

const leb = (value: number) => {
  const bytes: number[] = [];
  do {
    let byte = value & 0x7f;
    value = Math.floor(value / 128);
    bytes.push(byte | (value ? 0x80 : 0));
  } while (value);
  return bytes;
};
const section = (id: number, bytes: number[]) => [id, ...leb(bytes.length), ...bytes];
const string = (name: string) => [name.length, ...new TextEncoder().encode(name)];
function module(parameters: number[], results: number[], code: number[], imports: number[] = [0]) {
  const body = [0, ...code, 0x0b];
  return new WebAssembly.Module(
    new Uint8Array([
      0,
      97,
      115,
      109,
      1,
      0,
      0,
      0,
      ...section(1, [
        1,
        0x60,
        ...leb(parameters.length),
        ...parameters,
        ...leb(results.length),
        ...results,
      ]),
      ...section(2, imports),
      ...section(3, [1, 0]),
      ...section(7, [1, ...string("call"), 0, 0]),
      ...section(10, [1, ...leb(body.length), ...body]),
    ]),
  );
}
const contextImport = [1, ...string("env"), ...string("context"), 3, 0x7f, 1];

test("typed caller wrappers retain scalar, i64 and multi-value results and restore the owner", () => {
  const context = new WebAssembly.Global({ value: "i32", mutable: true }, 9);
  const provider = new WebAssembly.Instance(
    module([0x7f, 0x7e], [0x7f, 0x7e], [0x20, 0, 0x23, 0, 0x6a, 0x20, 1], contextImport),
    { env: { context } },
  ).exports.call as CallableFunction;
  const call = create_dylink_call_wrapper("[[127,126],[127,126]]", provider, context, 17);
  assert.deepEqual(call(25, 0x100000001n), [42, 0x100000001n]);
  assert.equal(context.value, 9);
});

test("caller owner constants preserve the complete i32 bit pattern", () => {
  const context = new WebAssembly.Global({ value: "i32", mutable: true }, 5);
  const provider = new WebAssembly.Instance(module([], [0x7f], [0x23, 0], contextImport), {
    env: { context },
  }).exports.call as CallableFunction;
  for (const owner of [0, 63, 64, 127, 128, 0x7fffffff, 0x80000000, 0xffffffff]) {
    const call = create_dylink_call_wrapper("[[],[127]]", provider, context, owner);
    assert.equal(call(), owner | 0);
    assert.equal(context.value, 5);
  }
});

test("same-context wrappers sharing a signature and owner bind independent targets", () => {
  const context = new WebAssembly.Global({ value: "i32", mutable: true }, 6);
  const first = new WebAssembly.Instance(module([0x7f], [0x7f], [0x20, 0, 0x41, 1, 0x6a])).exports
    .call as CallableFunction;
  const second = new WebAssembly.Instance(module([0x7f], [0x7f], [0x20, 0, 0x41, 2, 0x6a])).exports
    .call as CallableFunction;
  const callFirst = create_dylink_call_wrapper("[[127],[127]]", first, context, 17);
  const callSecond = create_dylink_call_wrapper("[[127],[127]]", second, context, 17);
  assert.equal(callFirst(40), 41);
  assert.equal(callSecond(40), 42);
  assert.equal(callFirst(40), 41);
  assert.equal(context.value, 6);
});

test("v128 values pass between real Wasm functions without entering JS", () => {
  const context = new WebAssembly.Global({ value: "i32", mutable: true }, 2);
  // i32x4.splat observes the wrapper owner and adds it to every input lane.
  const provider = new WebAssembly.Instance(
    module([0x7b], [0x7b], [0x20, 0, 0x23, 0, 0xfd, 0x11, 0xfd, 0xae, 1], contextImport),
    { env: { context } },
  ).exports.call as CallableFunction;
  const call = create_dylink_call_wrapper("[[123],[123]]", provider, context, 12);
  // Import type 0 is v128->v128; the scalar entry uses type 1.
  const body = [0, 0x20, 0, 0xfd, 0x11, 0x10, 0, 0xfd, 0x1b, 0, 0x0b];
  const consumer = new WebAssembly.Module(
    new Uint8Array([
      0,
      97,
      115,
      109,
      1,
      0,
      0,
      0,
      ...section(1, [2, 0x60, 1, 0x7b, 1, 0x7b, 0x60, 1, 0x7f, 1, 0x7f]),
      ...section(2, [1, ...string("env"), ...string("wrapped"), 0, 0]),
      ...section(3, [1, 1]),
      ...section(7, [1, ...string("call"), 0, 1]),
      ...section(10, [1, ...leb(body.length), ...body]),
    ]),
  );
  const instance = new WebAssembly.Instance(consumer, { env: { wrapped: call } });
  assert.equal((instance.exports.call as CallableFunction)(30), 42);
  assert.equal(context.value, 2);
});

test("nested owners and host exceptions restore their previous context", () => {
  const context = new WebAssembly.Global({ value: "i32", mutable: true }, 3);
  const innerTarget = new WebAssembly.Instance(module([], [0x7f], [0x23, 0], contextImport), {
    env: { context },
  }).exports.call as CallableFunction;
  const inner = create_dylink_call_wrapper("[[],[127]]", innerTarget, context, 22);
  const failure = { control: "exit" };
  const throwing = create_dylink_call_wrapper(
    "[[],[]]",
    () => {
      throw failure;
    },
    context,
    44,
  );
  const outer = create_dylink_call_wrapper(
    "[[],[127]]",
    () => {
      assert.equal(context.value, 11);
      assert.equal(inner(), 22);
      assert.equal(context.value, 11);
      assert.throws(
        () => throwing(),
        (error) => error === failure,
      );
      assert.equal(context.value, 11);
      return 42;
    },
    context,
    11,
  );
  assert.equal(outer(), 42);
  assert.equal(context.value, 3);
  assert.throws(
    () => throwing(),
    (error) => error === failure,
  );
  assert.equal(context.value, 3);
});

test("Wasm exceptions are rethrown with the original tag and payload", () => {
  const context = new WebAssembly.Global({ value: "i32", mutable: true }, 7);
  const tag = new WebAssembly.Tag({ parameters: ["i32"] });
  const target = new WebAssembly.Instance(
    module([0x7f], [], [0x20, 0, 0x08, 0], [1, ...string("env"), ...string("tag"), 4, 0, 0]),
    // The DOM ImportValue union omits tags accepted by the engine's EH API.
    { env: { tag } } as unknown as WebAssembly.Imports,
  ).exports.call as CallableFunction;
  const call = create_dylink_call_wrapper("[[127],[]]", target, context, 88);
  assert.throws(
    () => call(42),
    (error) => {
      assert.ok(error instanceof WebAssembly.Exception);
      assert.equal(error.is(tag), true);
      assert.equal(error.getArg(tag, 0), 42);
      return true;
    },
  );
  assert.equal(context.value, 7);
});

test("invalid owners, signatures and context types fail before a call", () => {
  const context = new WebAssembly.Global({ value: "i32", mutable: true }, 0);
  for (const owner of [-1, 1.5, 0x100000000, NaN])
    assert.throws(() => create_dylink_call_wrapper("[[],[]]", () => {}, context, owner), TypeError);
  for (const signature of ["[[112],[]]", "[null,[]]", "[[],[111]]"])
    assert.throws(() => create_dylink_call_wrapper(signature, () => {}, context, 1), TypeError);
  const immutable = new WebAssembly.Global({ value: "i32" }, 0);
  assert.throws(
    () => create_dylink_call_wrapper("[[],[]]", () => {}, immutable, 1),
    WebAssembly.LinkError,
  );
});
