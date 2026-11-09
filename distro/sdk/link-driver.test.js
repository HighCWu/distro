// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const wasmLdArguments = (result, label) => {
  const command = result.stderr
    .split(/\r?\n/)
    .find((line) => line.trimStart().startsWith('"') && line.includes("wasm-ld"));
  assert.ok(command, `${label}: no wasm-ld command in -### output:\n${result.stderr}`);
  return Array.from(command.matchAll(/"((?:\\.|[^"])*)"|(\S+)/g), (match) =>
    match[1] === undefined ? match[2] : match[1].replaceAll('\\"', '"'),
  );
};

const runCompiler = (compiler, directory, ...arguments_) => {
  const result = spawnSync(compiler, arguments_, { cwd: directory, encoding: "utf8" });
  const command = arguments_.map((argument) => JSON.stringify(argument)).join(" ");
  assert.equal(
    result.status,
    0,
    `compiler arguments: ${command}\n${result.stderr || String(result.error)}`,
  );
  return result;
};

const assertNoRelocatableDefaults = (result, label) => {
  const arguments_ = wasmLdArguments(result, label);
  assert.ok(arguments_.includes("-r") || arguments_.includes("--relocatable"), `${label}: no -r`);
  assert.equal(
    arguments_.some(
      (argument) =>
        argument.startsWith("@") && /wasm-linux-.*\.rsp$/.test(basename(argument.slice(1))),
    ),
    false,
    `${label}: SDK linker response file was loaded`,
  );
  for (const argument of arguments_) {
    assert.doesNotMatch(argument, /(?:^|\/)crt[^/]*\.o$/i, `${label}: CRT ${argument}`);
    assert.doesNotMatch(argument, /libc-exports\.a$/i, `${label}: libc ${argument}`);
    assert.doesNotMatch(argument, /libcxx-exports\.a$/i, `${label}: libc++ ${argument}`);
    assert.equal(argument.startsWith("-l"), false, `${label}: default library ${argument}`);
    assert.ok(
      ![
        "-lc",
        "-lpthread",
        "-lunwind",
        "-lc++",
        "-lc++abi",
        "--shared-memory",
        "-shared",
        "--growable-table",
        "--export=__stack_pointer",
      ].includes(argument),
      `${label}: unexpected default argument ${argument}`,
    );
    assert.equal(
      argument === "--table-base" || argument.startsWith("--table-base="),
      false,
      `${label}: table base ${argument}`,
    );
  }
  assert.doesNotMatch(result.stderr, /wasm[-_]opt/i, `${label}: must not invoke wasm-opt`);
  assert.doesNotMatch(
    result.stderr,
    /argument unused during compilation|unused command-line argument/i,
    `${label}: SDK link options produced an unused-option diagnostic`,
  );
  return arguments_;
};

const assertProfileResponse = (arguments_, fileName, label) => {
  assert.ok(
    arguments_.some(
      (argument) => argument.startsWith("@") && basename(argument.slice(1)) === fileName,
    ),
    `${label}: expected @sysroot/lib/${fileName}`,
  );
};

const wasmApi = async () => {
  const parser = process.env.SDK_LINK_PARSER;
  assert.ok(parser, "SDK_LINK_PARSER must name the built SDK's Wasm parser");
  return import(pathToFileURL(parser).href);
};

const assertMemoryProfile = (memoryTypes, moduleName, bits, maximumBytes) => {
  assert.equal(memoryTypes.imports.length, 1, `${moduleName}: expected one memory import`);
  assert.equal(memoryTypes.definitions.length, 0, `${moduleName}: memory must be imported`);
  const memoryImport = memoryTypes.imports[0];
  assert.equal(memoryImport.module, "env", `${moduleName}: memory import module`);
  assert.equal(memoryImport.name, "memory", `${moduleName}: memory import name`);
  assert.equal(
    memoryImport.type.address,
    bits === 64 ? "i64" : "i32",
    `${moduleName}: memory width`,
  );
  assert.equal(memoryImport.type.shared, true, `${moduleName}: memory must be shared`);
  assert.equal(
    memoryImport.type.maximum,
    BigInt(maximumBytes) / 65536n,
    `${moduleName}: memory maximum must match the SDK profile`,
  );
};

const assertMainProfile = (bytes, moduleName, bits, maximumBytes, api) => {
  const module = new WebAssembly.Module(bytes);
  const imports = WebAssembly.Module.imports(module);
  assert.ok(
    imports.some(
      (entry) => entry.kind === "memory" && entry.module === "env" && entry.name === "memory",
    ),
    `${moduleName}: missing env.memory import`,
  );
  assertMemoryProfile(api.read_wasm_memories(bytes), moduleName, bits, maximumBytes);
  const exports = WebAssembly.Module.exports(module);
  const exportNames = new Set(exports.map((entry) => entry.name));
  for (const name of [
    "_start",
    "__stack_pointer",
    "__wasm_mmap_v2",
    "__wasm_mmap_init_v1",
    "__wasm_signal_handler_v2",
  ])
    assert.ok(exportNames.has(name), `${moduleName}: missing runtime export ${name}`);
  return { module, exports };
};

test("memory profile checks the parser's {module,name,type} import shape", () => {
  assertMemoryProfile(
    {
      imports: [
        {
          module: "env",
          name: "memory",
          type: { address: "i32", minimum: 1n, maximum: 2n, shared: true },
        },
      ],
      definitions: [],
    },
    "synthetic main",
    32,
    131072n,
  );
});

test(
  "built SDK C -r combines PIC objects without defaults and keeps an ordinary executable profile",
  { skip: !process.env.SDK_LINK_CC && "requires the built SDK C compiler" },
  async () => {
    const compiler = process.env.SDK_LINK_CC;
    const bits = Number(process.env.SDK_LINK_BITS);
    const maximumBytes = BigInt(process.env.SDK_LINK_MAXIMUM);
    assert.ok(bits === 32 || bits === 64, "SDK_LINK_BITS must be 32 or 64");
    assert.ok(maximumBytes > 0n, "SDK_LINK_MAXIMUM must be a positive byte count");
    const api = await wasmApi();
    const directory = mkdtempSync(join(tmpdir(), "SDK C partial link "));
    try {
      writeFileSync(
        join(directory, "main.c"),
        "int main_value(int n) { return n + 40; }\n" +
          "int library_value(int);\n" +
          "int main(void) { return main_value(2) != 42 || library_value(1) != 42; }\n",
      );
      writeFileSync(
        join(directory, "side.c"),
        "extern int main_value(int); extern int helper_value(void);\n" +
          "int library_value(int n) { return main_value(n) + helper_value(); }\n",
      );
      writeFileSync(join(directory, "helper.c"), "int helper_value(void) { return 1; }\n");

      runCompiler(
        compiler,
        directory,
        "-O2",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-fPIC",
        "-c",
        "side.c",
        "-o",
        "side.o",
      );
      runCompiler(
        compiler,
        directory,
        "-O2",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-fPIC",
        "-c",
        "helper.c",
        "-o",
        "helper.o",
      );

      const directDryRun = runCompiler(
        compiler,
        directory,
        "-###",
        "-Werror",
        "-r",
        "side.o",
        "helper.o",
        "-o",
        "combined.o",
      );
      assertNoRelocatableDefaults(directDryRun, "direct C -r");
      runCompiler(compiler, directory, "-Werror", "-r", "side.o", "helper.o", "-o", "combined.o");

      writeFileSync(
        join(directory, "merge inner.rsp"),
        "'-Werror' '-r' 'side.o' 'helper.o' '-o' 'nested combined.o'\n",
      );
      writeFileSync(join(directory, "merge outer.rsp"), "@'merge inner.rsp'\n");
      const nestedDryRun = runCompiler(compiler, directory, "-###", "@merge outer.rsp");
      assertNoRelocatableDefaults(nestedDryRun, "nested response-file C -r");
      runCompiler(compiler, directory, "@merge outer.rsp");

      const combinedBytes = readFileSync(join(directory, "combined.o"));
      const combinedImports = api.read_wasm_dynamic_imports(new Uint8Array(combinedBytes), true);
      assert.ok(
        combinedImports.some((entry) => entry.kind === "function" && entry.name === "main_value"),
        "C -r must retain the unresolved main_value import",
      );
      assert.ok(readFileSync(join(directory, "nested combined.o")).byteLength > 0);

      const mainDryRun = runCompiler(compiler, directory, "-###", "main.c", "-o", "main.wasm");
      assertProfileResponse(
        wasmLdArguments(mainDryRun, "ordinary C main"),
        "wasm-linux-executable.rsp",
        "ordinary C main",
      );
      runCompiler(
        compiler,
        directory,
        "-O2",
        "-Wall",
        "-Wextra",
        "-Werror",
        "main.c",
        "combined.o",
        "-o",
        "main.wasm",
      );
      const mainBytes = new Uint8Array(readFileSync(join(directory, "main.wasm")));
      assertMainProfile(mainBytes, "ordinary C main", bits, maximumBytes, api);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "built SDK C++ accepts runtime-selection flags on -r and preserves the exception-tag executable profile",
  { skip: !process.env.SDK_LINK_CXX && "requires the built SDK C++ compiler" },
  async () => {
    const compiler = process.env.SDK_LINK_CXX;
    const bits = Number(process.env.SDK_LINK_BITS);
    const maximumBytes = BigInt(process.env.SDK_LINK_MAXIMUM);
    assert.ok(bits === 32 || bits === 64, "SDK_LINK_BITS must be 32 or 64");
    assert.ok(maximumBytes > 0n, "SDK_LINK_MAXIMUM must be a positive byte count");
    const api = await wasmApi();
    const directory = mkdtempSync(join(tmpdir(), "SDK CXX partial link "));
    const runtimeFlags = ["-stdlib=libc++", "--unwindlib=libunwind", "--rtlib=compiler-rt"];
    try {
      writeFileSync(
        join(directory, "main.cpp"),
        'extern "C" int main_value(int n) { return n + 40; }\n' +
          'extern "C" int library_value(int);\n' +
          "int main() { try { throw 42; } catch (int value) { return value == 42 && library_value(1) == 42 ? 0 : 1; } }\n",
      );
      writeFileSync(
        join(directory, "side.cpp"),
        'extern "C" int main_value(int); extern "C" int helper_value();\n' +
          'extern "C" int library_value(int n) { return main_value(n) + helper_value(); }\n',
      );
      writeFileSync(join(directory, "helper.cpp"), 'extern "C" int helper_value() { return 1; }\n');

      runCompiler(
        compiler,
        directory,
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
      runCompiler(
        compiler,
        directory,
        "-O0",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-std=c++17",
        "-fPIC",
        "-c",
        "helper.cpp",
        "-o",
        "helper.o",
      );

      const partialFlags = ["-Werror", ...runtimeFlags, "-r"];
      const partialDryRun = runCompiler(
        compiler,
        directory,
        "-###",
        ...partialFlags,
        "side.o",
        "helper.o",
        "-o",
        "combined.o",
      );
      assertNoRelocatableDefaults(partialDryRun, "C++ -r");
      runCompiler(compiler, directory, ...partialFlags, "side.o", "helper.o", "-o", "combined.o");
      const combinedImports = api.read_wasm_dynamic_imports(
        new Uint8Array(readFileSync(join(directory, "combined.o"))),
        true,
      );
      assert.ok(
        combinedImports.some((entry) => entry.kind === "function" && entry.name === "main_value"),
        "C++ -r must retain the unresolved main_value import",
      );

      const mainDryRun = runCompiler(
        compiler,
        directory,
        "-###",
        "-O0",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-std=c++17",
        "main.cpp",
        "combined.o",
        "-o",
        "main-cxx.wasm",
      );
      const mainCommand = wasmLdArguments(mainDryRun, "ordinary C++ main");
      assertProfileResponse(mainCommand, "wasm-linux-executable.rsp", "ordinary C++ main");
      assertProfileResponse(mainCommand, "wasm-linux-cxx.rsp", "ordinary C++ main");
      runCompiler(
        compiler,
        directory,
        "-O0",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-std=c++17",
        "main.cpp",
        "combined.o",
        "-o",
        "main-cxx.wasm",
      );
      const mainBytes = new Uint8Array(readFileSync(join(directory, "main-cxx.wasm")));
      const { exports } = assertMainProfile(
        mainBytes,
        "ordinary C++ main",
        bits,
        maximumBytes,
        api,
      );
      assert.ok(
        exports.some((entry) => entry.name === "__cpp_exception" && entry.kind === "tag"),
        "ordinary C++ main exports its canonical C++ exception tag",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
