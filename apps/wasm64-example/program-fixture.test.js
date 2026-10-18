// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("actual Nix Python control archive handles epoch inputs with fixed ZIP metadata", () => {
  const directory = mkdtempSync(join(tmpdir(), "linux-wasm-python-controls-"));
  try {
    const source = join(directory, "python-check.py");
    writeFileSync(source, readFileSync(new URL("./python-check.py", import.meta.url)));
    utimesSync(source, 1, 1);
    const recipe = readFileSync(
      new URL("../../distro/npm/browser-tests.nix", import.meta.url),
      "utf8",
    );
    const command = recipe.match(/wasm64PythonExampleSuite =[\s\S]*?python3 -c \\\n\s*'([^']+)'/);
    assert.ok(command, "use the actual Nix fixture-building command");
    const outputs = [join(directory, "first.pyz"), join(directory, "second.pyz")];
    const broken = spawnSync(
      "python3",
      [
        "-c",
        'import sys, zipfile; z = zipfile.ZipFile(sys.argv[2], "w"); z.write(sys.argv[1], "__main__.py"); z.close()',
        source,
        join(directory, "broken.pyz"),
      ],
      { encoding: "utf8", timeout: 5000 },
    );
    assert.notEqual(broken.status, 0);
    assert.match(broken.stderr, /timestamps before 1980/);
    for (const output of outputs) {
      const built = spawnSync("python3", ["-c", command[1], source, output], {
        encoding: "utf8",
        timeout: 5000,
      });
      assert.equal(built.status, 0, built.error?.message ?? built.stderr);
      const checked = spawnSync(
        "python3",
        [
          "-c",
          'import sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); assert z.namelist() == ["__main__.py"]; i = z.infolist()[0]; assert i.date_time == (1980,1,1,0,0,0); assert i.external_attr >> 16 == 0o100644; assert i.create_system == 3; assert i.compress_type == zipfile.ZIP_DEFLATED; assert z.read(i) == open(sys.argv[2], "rb").read()',
          output,
          source,
        ],
        { encoding: "utf8", timeout: 5000 },
      );
      assert.equal(checked.status, 0, checked.error?.message ?? checked.stderr);
      const run = spawnSync("python3", ["-I", output, "status", "literal $HOME → Python"], {
        encoding: "utf8",
        timeout: 5000,
      });
      assert.equal(run.status, 37, run.error?.message ?? run.stderr);
      assert.equal(run.stdout, "literal $HOME → Python\n");
      assert.equal(run.stderr, "Python application stderr\n");
    }
    assert.deepEqual(readFileSync(outputs[0]), readFileSync(outputs[1]));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("actual example zipapp runs in isolated Python mode and malformed ZIP input fails", () => {
  const directory = mkdtempSync(join(tmpdir(), "linux-wasm-python-launcher-"));
  try {
    const application = join(directory, "application.pyz");
    const build = spawnSync(
      "python3",
      [
        "-B",
        fileURLToPath(new URL("../../distro/python/build-example.py", import.meta.url)),
        application,
      ],
      { encoding: "utf8", timeout: 5000 },
    );
    assert.equal(build.status, 0, build.error?.message ?? build.stderr);
    const input = Buffer.from(Uint8Array.from({ length: 65553 }, (_, i) => i & 255));
    const result = spawnSync("python3", ["-I", application, "literal $HOME", "--uninterpreted"], {
      input,
      timeout: 5000,
    });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr?.toString());
    const prefix = readFileSync(
      new URL("../../distro/python/example/sampleapp/payload.txt", import.meta.url),
    );
    assert.deepEqual(result.stdout, Buffer.concat([prefix, Buffer.from(input).reverse()]));
    assert.equal(result.stderr.byteLength, 0);
    writeFileSync(application, Buffer.from("PK\x03\x04not-a-zip"));
    const invalid = spawnSync("python3", ["-I", application], { encoding: "utf8", timeout: 5000 });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /SyntaxError/);
    const fixture = spawnSync(
      "python3",
      [
        "-I",
        fileURLToPath(new URL("./python-check.py", import.meta.url)),
        "status",
        "literal $HOME → Python",
      ],
      { encoding: "utf8", timeout: 5000 },
    );
    assert.equal(fixture.status, 37, fixture.error?.message ?? fixture.stderr);
    assert.equal(fixture.stdout, "literal $HOME → Python\n");
    assert.equal(fixture.stderr, "Python application stderr\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("native input fixture verifies every binary byte and rejects corruption", () => {
  const directory = mkdtempSync(join(tmpdir(), "linux-wasm-input-fixture-"));
  try {
    const binary = join(directory, "program");
    const compiled = spawnSync(
      process.env.HOST_CC ?? "cc",
      [
        "-Wall",
        "-Wextra",
        "-Werror",
        "-O2",
        fileURLToPath(new URL("./program-check.c", import.meta.url)),
        "-o",
        binary,
      ],
      { encoding: "utf8" },
    );
    assert.equal(compiled.status, 0, compiled.error?.message ?? compiled.stderr);
    const bytes = Buffer.from(
      Uint8Array.from({ length: 512 * 1024 + 17 }, (_, i) => (i * 37 + 11) & 255),
    );
    for (const [mode, input, expected] of [
      [
        "pattern",
        bytes,
        `input bytes: ${bytes.length}, sum: ${bytes.reduce((sum, byte) => sum + byte, 0)}\n`,
      ],
      ["pattern", Buffer.alloc(0), "input bytes: 0, sum: 0\n"],
      ["prefix", bytes, "prefix byte: 11\n"],
    ]) {
      const result = spawnSync(binary, [mode], { input, encoding: "utf8", timeout: 5000 });
      assert.equal(result.status, 0, result.error?.message ?? result.stderr);
      assert.equal(result.stdout, expected);
    }
    bytes[40000] ^= 1;
    assert.equal(spawnSync(binary, ["pattern"], { input: bytes, timeout: 5000 }).status, 7);
    const output = join(directory, "result.bin");
    const generated = spawnSync(binary, ["output", output], { timeout: 5000 });
    assert.equal(generated.status, 0, generated.stderr?.toString());
    bytes[40000] ^= 1;
    assert.deepEqual(readFileSync(output), bytes.subarray(0, 65536 + 17));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
