// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test(
  "one dynamic SDK compiler handles object, executable and shared links",
  {
    skip: !process.env.DYNAMIC_SDK_CC && "requires the built dynamic SDK compiler",
  },
  () => {
    const directory = mkdtempSync(join(tmpdir(), "dynamic sdk driver "));
    const compiler = process.env.DYNAMIC_SDK_CC;
    const run = (...arguments_) => {
      const result = spawnSync(compiler, arguments_, { cwd: directory, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr || String(result.error));
      return result;
    };
    const exportsOf = (name) =>
      new Set(
        WebAssembly.Module.exports(new WebAssembly.Module(readFileSync(join(directory, name)))).map(
          (entry) => entry.name,
        ),
      );
    try {
      writeFileSync(
        join(directory, "main source.c"),
        "int main_value(int n) { return n + 40; }\nint main(void) { return main_value(2) != 42; }\n",
      );
      writeFileSync(
        join(directory, "side source.c"),
        "extern int main_value(int);\nint library_value(int n) { return main_value(n) + 1; }\n",
      );
      writeFileSync(
        join(directory, "compile inner.rsp"),
        '-Werror -c -fPIC "side source.c" -o "side object.o"\n',
      );
      writeFileSync(join(directory, "compile outer.rsp"), '@"compile inner.rsp"\n');
      writeFileSync(
        join(directory, "shared inner.rsp"),
        '-shared "side object.o" -Wl,-soname,libordinary.so -o "ordinary library.so"\n',
      );
      writeFileSync(join(directory, "shared outer.rsp"), '@"shared inner.rsp"\n');
      run("@compile outer.rsp");
      run("-O2", "main source.c", "-o", "ordinary main.wasm");
      run("@shared outer.rsp");

      const main = exportsOf("ordinary main.wasm");
      for (const name of [
        "_start",
        "__stack_pointer",
        "__indirect_function_table",
        "__wasm_dlopen_io_v1",
        "__wasm_mmap_v2",
        "__wasm_signal_handler_v2",
      ])
        assert.ok(main.has(name), `main execution export ${name}`);
      const side = new WebAssembly.Module(readFileSync(join(directory, "ordinary library.so")));
      const sideExports = new Set(WebAssembly.Module.exports(side).map((entry) => entry.name));
      assert.ok(sideExports.has("library_value"));
      for (const name of [
        "_start",
        "main",
        "__indirect_function_table",
        "__wasm_dlopen_io_v1",
        "__wasm_mmap_v2",
        "__wasm_signal_handler_v2",
      ])
        assert.equal(sideExports.has(name), false, `side library contains main export ${name}`);
      assert.ok(WebAssembly.Module.customSections(side, "dylink.0").length === 1);
      assert.ok(
        WebAssembly.Module.imports(side).some(
          (entry) => entry.name === "main_value" && entry.kind === "function",
        ),
      );

      for (const option of ["-nostdlib", "-nostartfiles"]) {
        run(
          option,
          "side object.o",
          "-Wl,--no-entry,--unresolved-symbols=import-dynamic",
          "-o",
          "without startup.wasm",
        );
        assert.equal(exportsOf("without startup.wasm").has("__wasm_dlopen_io_v1"), false, option);
      }
      const defaultsDisabled = run("-###", "-nodefaultlibs", "main source.c", "-o", "unused.wasm");
      assert.doesNotMatch(defaultsDisabled.stderr, /libc-exports\.a/);
      assert.doesNotMatch(defaultsDisabled.stderr, /"-lc"/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
