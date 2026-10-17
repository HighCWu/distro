// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = readFileSync(new URL("./application-test.sh", import.meta.url), "utf8");
const stage =
  "Lua embedding: installed archive, C callbacks, integer64, errors and coroutine verified";

test("application gate requires successful exit and complete output before publishing pass", () => {
  const directory = mkdtempSync(join(tmpdir(), "linux-wasm-lua-application-"));
  try {
    const notices = join(directory, "notices");
    mkdirSync(notices);
    for (const name of [
      "lua-readme.html",
      "musl-COPYRIGHT",
      "compiler-rt-LICENSE.TXT",
      "example-MIT",
    ])
      writeFileSync(join(notices, name), "Native test fixture notice\n");
    const program = join(directory, "example");
    const nativeScript = script
      .replaceAll("/share/licenses/lua/", `${notices}/`)
      .replaceAll("/tmp/lua-application.out", `${directory}/output`)
      .replace("/bin/lua-embedding-example", program)
      .replace("timeout -s KILL 10", "timeout -s KILL 0.1")
      .replace(/while :; do :; done\s*$/, "exit 0\n")
      .replace("while :; do :; done", "exit 1");
    const complete = `printf '%s\\n' '${stage}' '::vm-test::pass'\n`;
    for (const [name, body, valid] of [
      ["normal exit", complete + "exit 0", true],
      ["nonzero after pass", complete + "exit 7", false],
      ["missing stage", "echo ::vm-test::pass", false],
      ["missing pass", `echo '${stage}'`, false],
      ["explicit failure", complete + "echo ::vm-test::fail", false],
      ["stays alive after pass", complete + "while :; do :; done", false],
    ]) {
      writeFileSync(program, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      const result = spawnSync("sh", ["-eu", "-c", nativeScript], {
        encoding: "utf8",
        timeout: 5000,
      });
      assert.equal(result.error, undefined, `${name}: ${result.error}`);
      assert.equal(result.status, valid ? 0 : 1, `${name}: ${result.stdout}\n${result.stderr}`);
      // Failed child output may appear in diagnostics but must never become a
      // standalone outer protocol pass, even when the child printed one.
      assert.equal(/^::vm-test::pass$/m.test(result.stdout), valid, name);
      assert.equal(
        result.stdout.includes(
          "Lua application: installed example exits normally through Linux verified",
        ),
        valid,
        name,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
