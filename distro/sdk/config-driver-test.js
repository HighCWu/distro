// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

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
      '-Werror -c "source with spaces.c" -o "object with spaces.o"\n',
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
