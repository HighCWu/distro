// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

for (const [program, sourceNotice] of [
  ["quickjs", "LICENSE"],
  ["lua", "doc/readme.html"],
  ["openssl", "LICENSE.txt"],
  ["curl", "COPYING"],
]) {
  test(`${program} runtime license checks match the unchanged installed payload paths`, () => {
    const root = mkdtempSync(join(tmpdir(), `linux-wasm-${program}-notices-`));
    try {
      const source = join(root, "source");
      const output = join(root, "out");
      const musl = join(root, "musl");
      const runtime = join(root, "runtime");
      const put = (path, contents) => {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, contents);
      };
      put(join(source, sourceNotice), `${program} unmodified source notice fixture\n`);
      put(join(musl, "COPYRIGHT"), "musl original notice fixture\n");
      put(join(runtime, "compiler-rt/LICENSE.TXT"), "compiler-rt original notice fixture\n");
      const openssl = join(root, "openssl");
      const zlib = join(root, "zlib");
      if (program === "curl") {
        for (const name of ["LICENSE.txt", "musl-COPYRIGHT", "compiler-rt-LICENSE.TXT"])
          put(
            join(openssl, "share/licenses/openssl", name),
            `Original linked notice fixture: ${name}\n`,
          );
        put(join(zlib, "zlib.h"), "Original zlib header notice fixture\n");
      }
      const recipe = readFileSync(new URL(`../${program}/package.nix`, import.meta.url), "utf8");
      const copy = recipe.match(
        new RegExp(
          `    mkdir -p \\$out/share/licenses/${program}\\n([\\s\\S]*?)${["openssl", "curl"].includes(program) ? "\\n  '';" : "    runHook postInstall"}`,
        ),
      );
      assert.ok(copy, "execute actual package license-copy block");
      const shell = (`mkdir -p "$out/share/licenses/${program}"\n` + copy[1])
        .replaceAll("${musl.src}", musl)
        .replaceAll("${llvm-runtimes.src}", runtime)
        .replaceAll("${zlib.src}", zlib)
        .replaceAll("${openssl}", openssl)
        .replaceAll(
          "${../sdk/LICENSE.MIT}",
          new URL("../sdk/LICENSE.MIT", import.meta.url).pathname,
        );
      assert.doesNotMatch(shell, /\$\{/, "no unhandled Nix interpolation");
      const installed = spawnSync("sh", ["-eu", "-c", shell], {
        cwd: source,
        env: { ...process.env, out: output, dev: join(root, "dev") },
        encoding: "utf8",
      });
      assert.equal(installed.status, 0, installed.stderr);
      if (program === "lua") {
        for (const name of ["lua-readme.html", "musl-COPYRIGHT", "compiler-rt-LICENSE.TXT"])
          assert.deepEqual(
            readFileSync(join(root, "dev/share/licenses/lua", name)),
            readFileSync(join(output, "share/licenses/lua", name)),
          );
      }
      const script = readFileSync(
        new URL(
          `../${program}/${program === "openssl" ? "tests/cli-test.sh" : program === "curl" ? "tests/https-test.sh" : "language-test.sh"}`,
          import.meta.url,
        ),
        "utf8",
      );
      const check = script.match(/for license in [^\n]+; do\n[\s\S]*?\ndone/);
      assert.ok(check);
      const run = (text) =>
        spawnSync("sh", ["-eu", "-c", `fail() { exit 9; }\n${text}`], {
          encoding: "utf8",
        });
      // Model the package installer: payload /share stays /share, not /usr/share.
      const checkRoot = (text) =>
        text
          .replaceAll('"/share/', `"${output}/share/`)
          .replaceAll('"/usr/share/', `"${output}/usr/share/`);
      assert.equal(
        run(checkRoot(check[0])).status,
        0,
        "installed notices must pass runtime checks",
      );
      const wrongPrefix = check[0].replaceAll('"/share/', '"/usr/share/');
      assert.equal(run(checkRoot(wrongPrefix)).status, 9, "old /usr alias assumption must fail");
      for (const name of ["musl-COPYRIGHT", "compiler-rt-LICENSE.TXT"]) {
        const file = join(output, "share/licenses", program, name);
        const bytes = readFileSync(file);
        writeFileSync(file, "");
        assert.equal(run(checkRoot(check[0])).status, 9, "empty notices must fail");
        writeFileSync(file, bytes);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
