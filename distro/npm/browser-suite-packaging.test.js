// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("example browser suite can add dependencies to a copied read-only store bundle", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "wasm64-suite-packaging-"));
  const fixture = join(temporary, "fixture");
  const out = join(temporary, "suite");
  const brokenOut = join(temporary, "unwritable-suite");
  try {
    const payload = join(fixture, "node_modules/@lowland/kernel");
    await mkdir(payload, { recursive: true });
    await writeFile(join(payload, "index.js"), "export const fixture = true;\n");
    await chmod(join(payload, "index.js"), 0o444);
    await chmod(payload, 0o555);
    await chmod(join(fixture, "node_modules/@lowland"), 0o555);
    await chmod(join(fixture, "node_modules"), 0o555);
    const recipe = await readFile(new URL("./browser-tests.nix", import.meta.url), "utf8");
    const prefix = recipe.match(
      /wasm64ExampleSuite =[^\n]*''\n([\s\S]*?)    cp \$\{exampleServer wasm64-example\}/,
    );
    assert.ok(prefix, "find actual example-suite setup before test file installation");
    const shell = prefix[1]
      .replaceAll("${wasm64-example}", '"$fixture"')
      .replaceAll(
        '${playwright.linkRuntime "$out"}',
        'ln -s "$fixture" "$out/node_modules/@playwright"',
      );
    assert.doesNotMatch(shell, /\$\{/, "all Nix setup interpolations must be handled explicitly");
    if (process.getuid?.() !== 0) {
      const broken = spawnSync(
        "bash",
        ["-euc", shell.replace("chmod u+w $out/node_modules", ":")],
        {
          env: { ...process.env, fixture, out: brokenOut },
          encoding: "utf8",
        },
      );
      assert.notEqual(broken.status, 0, "the old setup must reject links into the read-only copy");
      assert.match(broken.stderr, /Permission denied/);
    }
    const result = spawnSync("bash", ["-euc", shell], {
      env: { ...process.env, fixture, out },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readlink(join(out, "node_modules/@playwright")), fixture);
    assert.equal((await stat(join(out, "node_modules"))).mode & 0o200, 0o200);
    for (const path of [fixture, out]) {
      assert.equal((await stat(join(path, "node_modules/@lowland/kernel"))).mode & 0o222, 0);
      assert.equal(
        (await stat(join(path, "node_modules/@lowland/kernel/index.js"))).mode & 0o222,
        0,
      );
      assert.equal(
        await readFile(join(path, "node_modules/@lowland/kernel/index.js"), "utf8"),
        "export const fixture = true;\n",
      );
    }
    assert.equal((await stat(join(fixture, "node_modules"))).mode & 0o222, 0);
  } finally {
    // Restore only this test's own temporary fixture/copy for cleanup.
    for (const path of [fixture, out, brokenOut]) {
      for (const suffix of [
        "node_modules",
        "node_modules/@lowland",
        "node_modules/@lowland/kernel",
      ]) {
        await chmod(join(path, suffix), 0o755).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
    }
    await rm(temporary, { recursive: true, force: true });
  }
});
