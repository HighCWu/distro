// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = readFileSync(new URL("./https-test.sh", import.meta.url), "utf8");
const stage = "curl: explicit-CA TLS1.3 transfer and certificate/hostname rejection verified";

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

test("native curl verifies Linux TCP TLS, rejects wrong trust/hostname and insecure mutation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "linux-wasm-curl-tls-"));
  try {
    const notices = join(directory, "notices");
    mkdirSync(notices);
    for (const name of [
      "curl-COPYING",
      "integration-MIT",
      "zlib.h",
      "openssl-LICENSE.txt",
      "musl-COPYRIGHT",
      "compiler-rt-LICENSE.TXT",
    ])
      writeFileSync(join(notices, name), `Native fixture notice: ${name}\n`);
    for (const [name, transform, valid] of [
      ["verified", (text) => text, true],
      ["verification-disabled", (text) => text.replace('--cacert "$2"', "--insecure"), false],
      [
        "trust-negative-accepted",
        (text) =>
          text.replace(
            'request localhost "$root/unrelated.pem"',
            'request localhost "$root/server.pem"',
          ),
        false,
      ],
      [
        "hostname-negative-accepted",
        (text) =>
          text.replace(
            'request wrong.invalid "$root/server.pem"',
            'request localhost "$root/server.pem"',
          ),
        false,
      ],
    ]) {
      const port = await freePort();
      const adapted = transform(script)
        .replace("root=/tmp/curl-tls", `root=${directory}/${name}`)
        .replace("port=9443", `port=${port}`)
        .replace("mount -t proc proc /proc", ":")
        .replace("ip link set lo up", ":")
        .replaceAll("/share/licenses/curl/", `${notices}/`)
        .replace(/while :; do :; done\s*$/, "exit 0\n")
        .replace("while :; do :; done", "exit 1");
      const result = spawnSync("sh", ["-eu", "-c", adapted], { encoding: "utf8", timeout: 30_000 });
      assert.equal(
        result.error,
        undefined,
        `${name}: ${result.error}\n${result.stdout}\n${result.stderr}`,
      );
      assert.equal(result.status, valid ? 0 : 1, `${name}: ${result.stdout}\n${result.stderr}`);
      assert.equal(result.stdout.includes(stage), valid, name);
      assert.equal(/^::vm-test::pass$/m.test(result.stdout), valid, name);
      if (valid)
        for (const marker of [
          "curl HTTPS: trusted localhost TLS1.3 over Linux TCP verified",
          "curl HTTPS: untrusted certificate rejected",
          "curl HTTPS: wrong hostname rejected",
        ])
          assert.ok(result.stdout.split("\n").includes(marker), marker);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("curl wasm64 selects matching OpenSSL/zlib and enforces the actual module ABI", () => {
  const scope = readFileSync(new URL("../../default.nix", import.meta.url), "utf8");
  const override = scope.match(/curl-wasm64 = self\.curl\.override \{([\s\S]*?)\n    \};/);
  assert.ok(override);
  for (const name of ["stdenv", "platform", "openssl", "zlib", "busybox"])
    assert.ok(override[1].includes(`${name} = self.${name}-wasm64;`), name);
  assert.match(override[1], /vm-test = vmTestWasm64;/);
  assert.match(scope, /zlib-wasm64 = self\.zlib\.override \{/);
  const recipe = readFileSync(new URL("../package.nix", import.meta.url), "utf8");
  assert.ok(
    recipe.includes(
      "src/curl ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}",
    ),
  );
  assert.match(recipe, /https = vm-test\.installedTest/);
  assert.match(recipe, /init = \.\/tests\/https-test.sh;/);
  assert.ok(script.includes(stage));
  assert.doesNotMatch(script, /--insecure|--proxy |sleep /);
  const syntax = spawnSync("sh", ["-n"], { input: script, encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
});
