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
      const command = arguments_.map((argument) => JSON.stringify(argument)).join(" ");
      assert.equal(
        result.status,
        0,
        `compiler arguments: ${command}\n${result.stderr || String(result.error)}`,
      );
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

      run(
        "-nostdlib",
        "side object.o",
        "-Wl,--no-entry,--unresolved-symbols=import-dynamic",
        "-o",
        "nostdlib.wasm",
      );
      assert.equal(exportsOf("nostdlib.wasm").has("__wasm_dlopen_io_v1"), false, "-nostdlib");

      run(
        "-nostartfiles",
        "main source.c",
        "side object.o",
        "-Wl,--no-entry",
        "-o",
        "nostartfiles.wasm",
      );
      const withoutStartFiles = exportsOf("nostartfiles.wasm");
      assert.ok(
        withoutStartFiles.has("__wasm_dlopen_io_v1"),
        "-nostartfiles keeps default runtime helpers",
      );
      assert.equal(withoutStartFiles.has("_start"), false, "-nostartfiles omits CRT entry point");
      const defaultsDisabled = run("-###", "-nodefaultlibs", "main source.c", "-o", "unused.wasm");
      assert.doesNotMatch(defaultsDisabled.stderr, /libc-exports\.a/);
      assert.doesNotMatch(defaultsDisabled.stderr, /"-lc"/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "dynamic C++ mains export the shared runtime for PIC exception modules",
  {
    skip:
      (!process.env.DYNAMIC_SDK_CXX ||
        !process.env.DYNAMIC_SDK_CXX_ARCHIVE ||
        !process.env.DYNAMIC_SDK_AR) &&
      "requires the built dynamic SDK C++ compiler",
  },
  () => {
    const directory = mkdtempSync(join(tmpdir(), "dynamic cxx sdk "));
    const compiler = process.env.DYNAMIC_SDK_CXX;
    const archive = process.env.DYNAMIC_SDK_CXX_ARCHIVE;
    const ar = process.env.DYNAMIC_SDK_AR;
    const run = (...arguments_) => {
      const result = spawnSync(compiler, arguments_, { cwd: directory, encoding: "utf8" });
      const command = arguments_.map((argument) => JSON.stringify(argument)).join(" ");
      assert.equal(
        result.status,
        0,
        `C++ compiler arguments: ${command}\n${result.stderr || String(result.error)}`,
      );
      return result;
    };
    const linkerArguments = (result) => {
      const line = result.stderr
        .split(/\r?\n/)
        .find(
          (candidate) => candidate.trimStart().startsWith('"') && candidate.includes("wasm-ld"),
        );
      assert.ok(line, `no wasm-ld command in -### output:\n${result.stderr}`);
      return Array.from(line.matchAll(/"((?:\\.|[^"])*)"|(\S+)/g), (match) =>
        match[1] === undefined ? match[2] : match[1].replaceAll('\\"', '"'),
      );
    };
    try {
      writeFileSync(
        join(directory, "main.cpp"),
        'extern "C" void cxx_main_throw() { throw 42; }\n' +
          "int main() { try { cxx_main_throw(); } catch (int n) { return n == 42 ? 0 : 1; } catch (...) { return 2; } return 3; }\n",
      );
      writeFileSync(
        join(directory, "side.cpp"),
        'extern "C" void cxx_main_throw();\n' +
          'extern "C" int cxx_side_catch() { try { cxx_main_throw(); } catch (int n) { return n; } catch (...) { return -1; } return 0; }\n' +
          'extern "C" void cxx_side_throw() { throw 7; }\n',
      );

      const archiveMembers = spawnSync(ar, ["t", archive], { encoding: "utf8" });
      assert.equal(archiveMembers.status, 0, archiveMembers.stderr);
      assert.ok(archiveMembers.stdout.trim(), "combined libc++ archive has members");

      const mainCommand = linkerArguments(
        run("-###", "-O0", "-std=c++17", "main.cpp", "-o", "main.wasm"),
      );
      const archiveIndex = mainCommand.indexOf(archive);
      assert.ok(archiveIndex > 0, "C++ main links the libc++ export archive");
      assert.equal(mainCommand[archiveIndex - 1], "--whole-archive");
      assert.equal(mainCommand[archiveIndex + 1], "--no-whole-archive");

      run("-O0", "-Wall", "-Wextra", "-Werror", "-std=c++17", "main.cpp", "-o", "main.wasm");
      run(
        "-O0",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-std=c++17",
        "-fPIC",
        "-c",
        "side.cpp",
        "-o",
        "side.o",
      );
      const sideCommand = linkerArguments(
        run("-###", "-shared", "side.o", "-Wl,-soname,libcxx-side.so", "-o", "side.so"),
      );
      assert.ok(sideCommand.includes("--unresolved-symbols=import-dynamic"));
      assert.equal(
        sideCommand.includes(archive),
        false,
        "side module must reuse main's C++ runtime",
      );
      assert.equal(sideCommand.includes("-lc++"), false);
      assert.equal(sideCommand.includes("-lc++abi"), false);
      assert.equal(sideCommand.includes("-lunwind"), false);
      assert.equal(sideCommand.includes("-lc"), false);
      run("-shared", "side.o", "-Wl,-soname,libcxx-side.so", "-o", "side.so");

      const mainModule = new WebAssembly.Module(readFileSync(join(directory, "main.wasm")));
      const mainExports = new Set(
        WebAssembly.Module.exports(mainModule).map((entry) => entry.name),
      );
      assert.ok(
        WebAssembly.Module.exports(mainModule).some(
          (entry) => entry.name === "__cpp_exception" && entry.kind === "tag",
        ),
        "main defines the canonical C++ exception tag",
      );
      for (const name of [
        "cxx_main_throw",
        "__cxa_throw",
        "_Unwind_CallPersonality",
        "_Unwind_GetWasmLPadContext",
      ])
        assert.ok(mainExports.has(name), `main exports shared C++ runtime symbol ${name}`);

      const sideModule = new WebAssembly.Module(readFileSync(join(directory, "side.so")));
      const sideImports = WebAssembly.Module.imports(sideModule);
      assert.ok(
        sideImports.some((entry) => entry.name === "__cpp_exception" && entry.kind === "tag"),
        "side imports the main C++ exception tag",
      );
      for (const name of [
        "cxx_main_throw",
        "__cxa_throw",
        "_Unwind_CallPersonality",
        "_Unwind_GetWasmLPadContext",
      ])
        assert.ok(
          sideImports.some((entry) => entry.name === name && entry.kind === "function"),
          `PIC C++ side module imports ${name} from its main runtime`,
        );
      assert.equal(
        sideImports.some((entry) => entry.name === "__wasm_lpad_context"),
        false,
        "PIC exception code uses the accessor instead of importing main TLS directly",
      );
      assert.equal(WebAssembly.Module.customSections(sideModule, "dylink.0").length, 1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
