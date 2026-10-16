// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const recipe = readFileSync(new URL("./license-texts.nix", import.meta.url), "utf8");
const script = recipe.match(/\n  ''\n([\s\S]*)\n  ''\s*$/)?.[1];
assert.ok(script, "test must execute the actual license-copy shell recipe");

for (const failure of ["none", "missing", "empty"]) {
  test(`SDK license bundle copies original notices and fails closed: ${failure}`, () => {
    const root = mkdtempSync(join(tmpdir(), "sdk-license-"));
    const files = new Map();
    const put = (path, text) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    };
    try {
      const sources = Object.fromEntries(
        ["musl", "linux", "llvm-toolchain", "llvm-runtimes"].map((name) => [
          name,
          join(root, name),
        ]),
      );
      const add = (source, relative) => {
        const text = `Unmodified fixture notice: ${source}/${relative}\n`;
        put(join(sources[source], relative), text);
        files.set(`${source}/${relative}`, text);
      };
      add("musl", "COPYRIGHT");
      add("linux", "COPYING");
      add("linux", "LICENSES/exceptions/Linux-syscall-note");
      for (const component of ["llvm", "clang", "lld"])
        add("llvm-toolchain", `${component}/LICENSE.TXT`);
      for (const component of ["compiler-rt", "libcxx", "libcxxabi", "libunwind"])
        add("llvm-runtimes", `${component}/LICENSE.TXT`);
      const copyright = join(sources.musl, "COPYRIGHT");
      if (failure === "missing") rmSync(copyright);
      if (failure === "empty") writeFileSync(copyright, "");
      const index = join(root, "index.json");
      put(index, '{"scope":"fixture only"}\n');
      const values = {
        ...Object.fromEntries(
          Object.entries(sources).map(([name, path]) => [`sources.${name}`, path]),
        ),
        sourceIndex: index,
        "./license-texts.README.md": new URL("./license-texts.README.md", import.meta.url).pathname,
        "./LICENSE.MIT": new URL("./LICENSE.MIT", import.meta.url).pathname,
      };
      const shell = script.replace(/\$\{([^}]+)\}/g, (_match, key) => {
        assert.ok(Object.hasOwn(values, key), `unhandled Nix interpolation: ${key}`);
        return "'" + values[key].replaceAll("'", "'\\''") + "'";
      });
      const output = join(root, "out");
      const result = spawnSync("bash", ["-euo", "pipefail", "-c", shell], {
        encoding: "utf8",
        env: { ...process.env, out: output, TMPDIR: root },
      });
      if (failure !== "none") {
        assert.notEqual(result.status, 0, "missing/empty notices must fail the build");
        return;
      }
      assert.equal(result.status, 0, result.stderr);
      const directory = join(output, "share/linux-wasm-sdk/licenses");
      for (const [path, text] of files) {
        const destination = path.replace(
          /^(llvm-toolchain|llvm-runtimes)\/([^/]+)\/LICENSE.TXT$/,
          "$1/$2-LICENSE.TXT",
        );
        assert.equal(readFileSync(join(directory, destination), "utf8"), text);
      }
      const sums = readFileSync(join(directory, "SHA256SUMS"), "utf8");
      assert.match(sums, /Linux-syscall-note/);
      assert.match(sums, /SDK-MIT.txt/);
      assert.doesNotMatch(sums, /SHA256SUMS|empty-license-files/);
      put(join(directory, "musl/COPYRIGHT"), "tampered\n");
      assert.notEqual(
        spawnSync("sha256sum", ["--check", "SHA256SUMS"], { cwd: directory }).status,
        0,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
