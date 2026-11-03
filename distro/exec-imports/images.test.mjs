// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { image } from "./images.mjs";
import {
  read_wasm_memories,
  user_memory_import,
  user_poll_globals_supported,
} from "../../packages/kernel/src/wasm_binary.ts";
import { user_module_imports_supported } from "../../packages/kernel/src/wasm.ts";
import { user_function_imports_supported } from "../../packages/kernel/src/user-functions.ts";

for (const bits of [32, 64]) {
  test(`wasm${bits}: executable entry must exist with the exact no-argument void ABI`, () => {
    const address = bits === 64 ? "i64" : "i32";
    for (const mode of ["good", "entry-missing", "entry-argument", "entry-result", "entry-kind"]) {
      const bytes = image(bits, mode),
        module = new WebAssembly.Module(bytes);
      assert(user_module_imports_supported(module));
      assert(
        user_function_imports_supported(bytes, address),
        "old import-only gate admits invalid entries",
      );
      assert.equal(user_function_imports_supported(bytes, address, true), mode === "good");
    }
  });
  test(`wasm${bits}: typed imports reject erased JS ABI mismatches without executing a start section`, () => {
    const address = bits === 64 ? "i64" : "i32",
      word = (n) => (bits === 64 ? BigInt(n) : n);
    for (const mode of [
      "good",
      "syscall-width",
      "syscall-result",
      "syscall-arity",
      "poll-result",
    ]) {
      const bytes = image(bits, mode),
        module = new WebAssembly.Module(bytes),
        globals = [];
      assert(user_module_imports_supported(module));
      read_wasm_memories(bytes, globals);
      assert(user_poll_globals_supported(globals, address));
      // The original JS imports link every signature, including incorrect ones.
      const imports = {
        env: {
          memory: new WebAssembly.Memory({
            initial: word(2),
            maximum: word(bits === 64 ? 262144 : 65536),
            shared: true,
            address,
          }),
        },
        linux: {
          syscall: () => {
            throw new Error("user code executed");
          },
        },
        linux_user_poll_v2: {
          checkpoint: () => 0,
          thread_pointer: new WebAssembly.Global({ value: address, mutable: true }, word(0)),
        },
      };
      new WebAssembly.Instance(module, imports);
      assert.equal(user_function_imports_supported(bytes, address), mode === "good");
      const started = image(bits, mode, true);
      assert.equal(user_function_imports_supported(started, address), mode === "good");
      assert.throws(
        () => new WebAssembly.Instance(new WebAssembly.Module(started), imports),
        /user code executed/,
      );
    }
  });
  test(`wasm${bits}: valid images distinguish precommit global admission from a late LinkError`, () => {
    const address = bits === 64 ? "i64" : "i32",
      word = (n) => (bits === 64 ? BigInt(n) : n);
    for (const mode of ["good", "immutable", "width", "float"]) {
      const bytes = image(bits, mode),
        globals = [];
      const module = new WebAssembly.Module(bytes);
      assert(user_module_imports_supported(module), "name/kind admission alone is insufficient");
      assert(user_function_imports_supported(bytes, address));
      const memory = user_memory_import(read_wasm_memories(bytes, globals), address);
      assert(memory);
      assert.equal(globals.length, 1);
      assert.equal(user_poll_globals_supported(globals, address), mode === "good");
      const imports = {
        env: {
          memory: new WebAssembly.Memory({
            initial: word(2),
            maximum: word(bits === 64 ? 262144 : 65536),
            shared: true,
            address,
          }),
        },
        linux_user_poll_v2: {
          checkpoint: () => 0,
          thread_pointer: new WebAssembly.Global({ value: address, mutable: true }, word(0)),
        },
        linux: {
          syscall: (nr, status, ...args) => {
            assert.equal(nr, word(94));
            assert.equal(status, word(0));
            assert(args.every((value) => value === word(0)));
            throw exit;
          },
        },
      };
      const exit = Symbol("exit");
      if (mode === "good") {
        const instance = new WebAssembly.Instance(module, imports);
        assert.equal(instance.exports.__wasm_user_poll_abi(), 2);
        assert.throws(
          () => instance.exports._start(),
          (error) => error === exit,
        );
      } else {
        // Negative control: the original names-only route reaches a real
        // engine link failure, after Linux would already have committed exec.
        assert.throws(() => new WebAssembly.Instance(module, imports), WebAssembly.LinkError);
      }
    }
  });
}
