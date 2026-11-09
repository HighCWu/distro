// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("SDK compiler ignores ambient host include and library paths but accepts explicit paths", (context) => {
  const compiler = process.env.SDK_TEST_CLANG || "clang-22";
  const version = spawnSync(compiler, ["--version"], { encoding: "utf8" });
  if (!process.env.SDK_TEST_CLANG && version.error?.code === "ENOENT") {
    context.skip("Clang 22 is not installed; SDK CI uses its pinned compiler");
    return;
  }
  assert.equal(version.status, 0, version.stderr || String(version.error));
  const root = mkdtempSync(join(tmpdir(), "linux-wasm-sdk-environment-"));
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  try {
    const host = join(root, "host paths");
    mkdirSync(host);
    writeFileSync(join(host, "sdk_ambient_probe.h"), "#define SDK_AMBIENT_PROBE 42\n");
    const profile = join(root, "profile.cfg");
    writeFileSync(profile, "");
    const script = readFileSync(new URL("./compiler.sh", import.meta.url), "utf8")
      .replaceAll("@compiler@", quote(compiler))
      .replaceAll("@configArgument@", quote(`--config=${profile}`));
    const env = { ...process.env };
    for (const name of [
      "CPATH",
      "C_INCLUDE_PATH",
      "CPLUS_INCLUDE_PATH",
      "OBJC_INCLUDE_PATH",
      "LIBRARY_PATH",
    ])
      delete env[name];
    const run = (args, extra, wrapped = true, input = "") =>
      spawnSync(wrapped ? "bash" : compiler, wrapped ? ["-c", script, "sdk", ...args] : args, {
        env: { ...env, ...extra },
        encoding: "utf8",
        input,
      });
    for (const [variable, language] of [
      ["CPATH", "c"],
      ["CPATH", "c++"],
      ["C_INCLUDE_PATH", "c"],
      ["CPLUS_INCLUDE_PATH", "c++"],
      ["OBJC_INCLUDE_PATH", "objective-c"],
    ]) {
      const args = ["-E", "-P", "-x", language, "-"];
      const input = "#include <sdk_ambient_probe.h>\nSDK_AMBIENT_PROBE\n";
      const extra = { [variable]: host };
      const control = run(args, extra, false, input);
      assert.equal(control.status, 0, control.stderr);
      assert.match(control.stdout, /\b42\b/);
      const isolated = run(args, extra, true, input);
      assert.notEqual(isolated.status, 0, `${variable} leaked a host header into ${language}`);
      assert.match(isolated.stderr, /sdk_ambient_probe.h/);
      const explicit = run(["-I", host, ...args], extra, true, input);
      assert.equal(explicit.status, 0, explicit.stderr);
      assert.match(explicit.stdout, /\b42\b/);
    }
    // Inspect only the driver's link command; do not link host libraries into
    // a target binary. This is an environment-policy test, not Wasm execution.
    const args = ["-###", "-x", "c", "-", "-o", join(root, "unused")];
    const control = run(args, { LIBRARY_PATH: host }, false);
    assert.equal(control.status, 0, control.stderr);
    assert.ok(control.stderr.includes(host), "negative control did not expose LIBRARY_PATH");
    const isolated = run(args, { LIBRARY_PATH: host });
    assert.equal(isolated.status, 0, isolated.stderr);
    assert.ok(!isolated.stderr.includes(host), "LIBRARY_PATH leaked into SDK linker search paths");
    const explicit = run(["-L", host, ...args], { LIBRARY_PATH: host });
    assert.equal(explicit.status, 0, explicit.stderr);
    assert.ok(explicit.stderr.includes(host), "explicit target -L was discarded");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Clang config applies link-only options after expanding nested response files", (context) => {
  const compiler = process.env.SDK_TEST_CLANG || "clang-22";
  const version = spawnSync(compiler, ["--version"], { encoding: "utf8" });
  if (!process.env.SDK_TEST_CLANG && version.error?.code === "ENOENT") {
    context.skip("Clang 22 is not installed; SDK CI runs this test with its pinned compiler");
    return;
  }
  assert.equal(version.status, 0, version.stderr || String(version.error));
  const directory = mkdtempSync(join(tmpdir(), "linux-wasm-driver-"));
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  try {
    writeFileSync(
      join(directory, "profile with spaces.cfg"),
      `${process.env.SDK_TEST_TARGET ? `${quote(`--target=${process.env.SDK_TEST_TARGET}`)}\n` : ""}'-DSDK_COMPILE_MARKER=1'\n'$-Wl,--defsym,sdk_link_marker=42'\n`,
    );
    writeFileSync(
      join(directory, "source with spaces.c"),
      "#ifndef SDK_COMPILE_MARKER\n#error config not applied\n#endif\nint main(void) { return 0; }\n",
    );
    writeFileSync(
      join(directory, "compile inner.rsp"),
      '-Werror -x c -c "source with spaces.c" -o "object with spaces.o"\n',
    );
    writeFileSync(join(directory, "compile outer.rsp"), '@"compile inner.rsp"\n');
    writeFileSync(join(directory, "link.rsp"), '"object with spaces.o" -o "application"\n');
    const template = readFileSync(new URL("./compiler.sh", import.meta.url), "utf8");
    const script = template
      .replaceAll("@compiler@", quote(compiler))
      .replaceAll(
        "@configArgument@",
        quote(`--config=${join(directory, "profile with spaces.cfg")}`),
      );
    const run = (args) =>
      spawnSync("bash", ["-c", script, "sdk", ...args], {
        cwd: directory,
        encoding: "utf8",
      });
    // If link-only options leaked into -c, -Werror would reject them.
    let result = run(["@compile outer.rsp"]);
    assert.equal(result.status, 0, result.stderr);
    result = run(["-###", "@compile outer.rsp"]);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /sdk_link_marker/);
    result = run(["-###", "@link.rsp"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /sdk_link_marker=42/);
    // Dry-run link inspection tests the driver, not the build host's libc.
    // Real linking and execution are tested by the SDK's Wasm checks.
    result = run(["@missing.rsp"]);
    assert.notEqual(result.status, 0, "missing response file was silently accepted");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("normal config applies the Wasm optimizer driver policy", (context) => {
  const compiler = process.env.SDK_TEST_CLANG || "clang-22";
  const version = spawnSync(compiler, ["--version"], { encoding: "utf8" });
  if (!process.env.SDK_TEST_CLANG && version.error?.code === "ENOENT") {
    context.skip("Clang 22 is not installed; SDK CI uses its pinned compiler");
    return;
  }
  assert.equal(version.status, 0, version.stderr || String(version.error));
  const directory = mkdtempSync(join(tmpdir(), "linux-wasm-no-opt-config-"));
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  try {
    const fakeBin = join(directory, "fake-bin");
    mkdirSync(fakeBin);
    const fakeWasmOpt = join(fakeBin, "wasm-opt");
    const marker = join(directory, "wasm-opt-invoked");
    writeFileSync(fakeWasmOpt, `#!/bin/sh\n: > ${quote(marker)}\nexit 97\n`);
    chmodSync(fakeWasmOpt, 0o755);
    const env = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH || ""}`,
    };
    const tailConfig = join(directory, "tail.cfg");
    const normalConfig = join(directory, "normal.cfg");
    writeFileSync(tailConfig, "'$--no-wasm-opt'\n");
    writeFileSync(normalConfig, "'--no-wasm-opt'\n");
    const source = join(directory, "main.c");
    writeFileSync(source, "int main(void) { return 0; }\n");
    const run = (args) =>
      spawnSync(compiler, args, {
        cwd: directory,
        env,
        encoding: "utf8",
        timeout: 30000,
      });
    const common = [
      "--target=wasm32-unknown-unknown",
      "-x",
      "c",
      "-O2",
      "-nostdlib",
      "-Wl,--no-entry",
      source,
      "-o",
      join(directory, "main.wasm"),
    ];
    const tailDryRun = run([`--config=${tailConfig}`, ...common, "-###"]);
    assert.equal(tailDryRun.status, 0, tailDryRun.stderr || String(tailDryRun.error));
    assert.ok(
      tailDryRun.stderr.includes(fakeWasmOpt),
      "tail config negative control did not select fake wasm-opt",
    );
    const normalDryRun = run([`--config=${normalConfig}`, ...common, "-###"]);
    assert.equal(normalDryRun.status, 0, normalDryRun.stderr || String(normalDryRun.error));
    assert.ok(
      !normalDryRun.stderr.includes(fakeWasmOpt),
      "normal no-wasm-opt config selected wasm-opt",
    );

    const compile = run([
      `--config=${normalConfig}`,
      "--target=wasm32-unknown-unknown",
      "-x",
      "c",
      "-O2",
      "-nostdlib",
      "-Werror",
      "-c",
      source,
      "-o",
      join(directory, "main.o"),
    ]);
    assert.equal(compile.status, 0, compile.stderr || String(compile.error));
    const link = run([`--config=${normalConfig}`, ...common]);
    assert.equal(link.status, 0, link.stderr || String(link.error));
    assert.equal(existsSync(marker), false, "wasm-opt marker should not exist");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
