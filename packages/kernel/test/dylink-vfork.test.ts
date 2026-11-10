// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { ProcessDylink } from "../src/dylink_process.ts";
import type { WasmAddress } from "../src/wasm.ts";

function blockedLoader(address: "i32" | "i64") {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const table = new WebAssembly.Table({ element: "anyfunc", initial: 4 });
  const stack = new WebAssembly.Global({ value: "i32", mutable: true }, 0);
  let ioChecks = 0;
  let allocations = 0;
  let reads = 0;
  let releases = 0;
  let pins = 0;
  let unpins = 0;
  const process = new ProcessDylink({
    main: {
      exports: {
        __indirect_function_table: table,
        __stack_pointer: stack,
        __wasm_dlopen_io_v1: () => {
          ioChecks++;
          return 1;
        },
        __wasm_dlopen_allocate: () => {
          allocations++;
          return address === "i64" ? 512n : 512;
        },
        __wasm_dlopen_deallocate: () => {},
        __wasm_dlopen_read: () => {
          reads++;
          return address === "i64" ? 0n : 0;
        },
        __wasm_dlopen_read_release: () => {
          releases++;
        },
      },
    } as unknown as WebAssembly.Instance,
    memory,
    address,
    maximumPages: 1,
    // The blocked-operation test never indexes a table; keep the tiny fixture
    // table32 so it remains constructible on Node versions without table64.
    tableType: { address: "i32", minimum: 4n },
    signatures: new Map(),
    blocked: () => true,
    isControlFlow: () => false,
    fatal(error) {
      throw error;
    },
    pinFile: () => {
      pins++;
      return 1;
    },
    unpinFile: () => {
      unpins++;
      return 0;
    },
  });
  return {
    process,
    memory,
    counts: () => ({ ioChecks, allocations, reads, releases, pins, unpins }),
  };
}

for (const address of ["i32", "i64"] as const) {
  const word = (value: number): WasmAddress => (address === "i64" ? BigInt(value) : value);

  test(`${address}: vfork blocks loader operations before reading guest inputs`, () => {
    const loader = blockedLoader(address);
    const { process } = loader;

    assert.equal(process.open(word(0xffff), 0), word(0));
    assert.equal(process.symbol(word(0), word(0xffff)), word(0));
    assert.equal(process.address(word(0xffff), word(0xffff)), 0);
    assert.equal(process.valid(word(1)), 0);

    const errorAddress = 64;
    assert.equal(process.error(word(errorAddress), word(128)), 0);
    const message = new TextDecoder().decode(
      new Uint8Array(loader.memory.buffer, errorAddress, 128).subarray(0, 64),
    );
    assert.match(message, /vfork child is active/);
    assert.deepEqual(loader.counts(), {
      ioChecks: 1,
      allocations: 0,
      reads: 0,
      releases: 0,
      pins: 0,
      unpins: 0,
    });
  });
}
