// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const template = readFileSync(new URL("./finalize.sh", import.meta.url), "utf8");
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

function fixture(t, fail = false) {
  const dir = mkdtempSync(join(tmpdir(), "fork sdk "));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const input = join(dir, "linked file.wasm");
  const output = join(dir, "final file.wasm");
  const log = join(dir, "arguments.json");
  const stub = join(dir, "wasm-opt.mjs");
  writeFileSync(input, "input");
  writeFileSync(output, "old-output");
  writeFileSync(
    stub,
    `
    import { writeFileSync } from 'node:fs';
    const args = process.argv.slice(2);
    writeFileSync(${JSON.stringify(log)}, JSON.stringify(args));
    writeFileSync(args[args.indexOf('-o') + 1], 'transformed');
    process.exit(${fail ? 17 : 0});
  `,
  );
  const script =
    "set -euo pipefail\n" +
    template.replaceAll("@wasmOpt@", `${quote(process.execPath)} ${quote(stub)}`);
  const run = (args = [input, output]) =>
    spawnSync("bash", ["-c", script, "finalize", ...args], {
      encoding: "utf8",
    });
  return { dir, input, output, log, run };
}

test("finalizer applies whole-link Asyncify with the explicit checkpoint import", (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(f.output, "utf8"), "transformed");
  assert.equal(readFileSync(f.input, "utf8"), "input");
  const args = JSON.parse(readFileSync(f.log, "utf8"));
  assert.equal(args[0], f.input);
  assert.ok(args.includes("--asyncify"));
  assert.ok(args.includes("--pass-arg=asyncify-imports@linux_fork_v1.checkpoint,linux.syscall"));
  assert.ok(args.includes("--pass-arg=asyncify-asserts"));
  assert.ok(!args.includes("--all-features"));
  assert.ok(!readdirSync(f.dir).some((name) => name.includes(".tmp.")));
});

test("failed transformation preserves input/output and removes its temporary file", (t) => {
  const f = fixture(t, true);
  assert.equal(f.run().status, 17);
  assert.equal(readFileSync(f.output, "utf8"), "old-output");
  assert.equal(readFileSync(f.input, "utf8"), "input");
  assert.ok(!readdirSync(f.dir).some((name) => name.includes(".tmp.")));
});

test("usage, missing input, identical paths and hard-link aliases fail closed", (t) => {
  const f = fixture(t);
  for (const args of [
    [],
    [f.input],
    [f.input, f.output, "extra"],
    [join(f.dir, "absent"), f.output],
    [f.input, f.input],
  ]) {
    assert.equal(f.run(args).status, 64);
  }
  const alias = join(f.dir, "alias.wasm");
  linkSync(f.input, alias);
  assert.equal(f.run([f.input, alias]).status, 64);
  assert.equal(readFileSync(f.input, "utf8"), "input");
});

test("the dual-width runtime corpus consumes the installed SDK tools", () => {
  const recipe = readFileSync(new URL("./package.nix", import.meta.url), "utf8");
  assert.match(recipe, /wasm-linux-fork-cc .* -c .*runtime\.c/);
  assert.match(recipe, /wasm-linux-fork-cc -pthread runtime\.o raw-clone\.o -o raw\.wasm/);
  assert.match(recipe, /wasm-linux-fork-finalize raw\.wasm/);
  assert.ok(!recipe.includes("--asyncify"));
  const scope = readFileSync(new URL("../default.nix", import.meta.url), "utf8");
  assert.match(scope, /sdk-fork-continuation = self\.sdk-fork-continuation-wasm64/);
});
