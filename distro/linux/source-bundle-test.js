// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  linkSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const script = new URL("./source-bundle.sh", import.meta.url).pathname;
test("source bundle streams complete trees reproducibly without rewriting source links", () => {
  const root = mkdtempSync(join(tmpdir(), "kernel-source-bundle-"));
  const source = join(root, "source.[x], with space");
  const linux = join(root, "output");
  const put = (path, contents) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  };
  try {
    put(join(source, "COPYING"), "Unmodified Linux notice\n");
    put(join(source, "Makefile"), "all:\n\techo test\n");
    put(join(source, ".hidden"), "Hidden source file\n");
    put(join(source, "arch/wasm/example.c"), "source bytes\n");
    linkSync(join(source, "arch/wasm/example.c"), join(source, "arch/wasm/hard.c"));
    symlinkSync("example.c", join(source, "arch/wasm/link.c"));
    put(join(linux, "linux-build/kernel.config"), "CONFIG_MMU=n\n");
    put(join(linux, "linux-build/build.json"), '{"wasmBits":64}\n');
    put(join(linux, "vmlinux.wasm"), "must not enter source archive\n");
    const first = join(root, "first.tar.gz");
    const second = join(root, "second.tar.gz");
    for (const archive of [first, second]) {
      const built = spawnSync("bash", [script, source, linux, archive], { encoding: "utf8" });
      assert.equal(built.status, 0, built.stderr);
    }
    assert.deepEqual(readFileSync(first), readFileSync(second), "gzip/tar headers must be stable");
    const alias = join(root, "source-alias");
    symlinkSync(source, alias);
    const aliased = spawnSync("bash", [script, alias, linux, second], { encoding: "utf8" });
    assert.equal(aliased.status, 0, aliased.stderr);
    assert.deepEqual(
      readFileSync(first),
      readFileSync(second),
      "a source-root symlink must resolve to the full tree",
    );
    const listing = spawnSync("tar", ["-tzf", first], { encoding: "utf8" });
    assert.equal(listing.status, 0, listing.stderr);
    assert.deepEqual(listing.stdout.trim().split("\n"), [
      "linux/",
      "linux/.hidden",
      "linux/COPYING",
      "linux/Makefile",
      "linux/arch/",
      "linux/arch/wasm/",
      "linux/arch/wasm/example.c",
      "linux/arch/wasm/hard.c",
      "linux/arch/wasm/link.c",
      "build-materials/",
      "build-materials/build.json",
      "build-materials/kernel.config",
    ]);
    const link = spawnSync("tar", ["-tvzf", first], { encoding: "utf8" });
    assert.match(link.stdout, /linux\/arch\/wasm\/link\.c -> example\.c/);
    assert.match(link.stdout, /linux\/arch\/wasm\/hard\.c link to linux\/arch\/wasm\/example\.c/);
    const unpacked = join(root, "unpacked");
    mkdirSync(unpacked);
    assert.equal(spawnSync("tar", ["-xzf", first, "-C", unpacked]).status, 0);
    assert.deepEqual(
      readFileSync(join(unpacked, "linux/arch/wasm/link.c")),
      Buffer.from("source bytes\n"),
    );
    assert.equal(
      statSync(join(unpacked, "linux/arch/wasm/example.c")).ino,
      statSync(join(unpacked, "linux/arch/wasm/hard.c")).ino,
    );
    for (const [path, original] of [
      ["linux/COPYING", join(source, "COPYING")],
      ["linux/arch/wasm/example.c", join(source, "arch/wasm/example.c")],
      ["build-materials/kernel.config", join(linux, "linux-build/kernel.config")],
    ]) {
      const extracted = spawnSync("tar", ["-xOzf", first, path]);
      assert.equal(extracted.status, 0);
      assert.deepEqual(extracted.stdout, readFileSync(original));
    }
    rmSync(join(linux, "linux-build/kernel.config"));
    const missing = spawnSync("bash", [script, source, linux, second]);
    assert.notEqual(missing.status, 0, "an archive without the actual configuration must fail");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
