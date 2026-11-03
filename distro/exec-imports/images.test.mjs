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

for (const bits of [32, 64]) {
  test(`wasm${bits}: valid images distinguish precommit global admission from a late LinkError`, () => {
    const address = bits === 64 ? "i64" : "i32",
      word = (n) => (bits === 64 ? BigInt(n) : n);
    for (const mode of ["good", "immutable", "width", "float"]) {
      const bytes = image(bits, mode),
        globals = [];
      const module = new WebAssembly.Module(bytes);
      assert(user_module_imports_supported(module), "name/kind admission alone is insufficient");
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
