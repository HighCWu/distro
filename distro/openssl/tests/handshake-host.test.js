// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const source = readFileSync(new URL("./verified-handshake.c", import.meta.url), "utf8");
const stage =
  "OpenSSL: verified TLS1.3, binary I/O, untrusted certificate and wrong hostname rejection";

test("native TLS consumer validates trust and hostname with GCC and Clang", () => {
  const root = mkdtempSync(join(tmpdir(), "linux-wasm-tls-"));
  try {
    const metadata = spawnSync("pkg-config", ["--cflags", "--libs", "openssl"], {
      encoding: "utf8",
    });
    assert.equal(metadata.status, 0, "install libssl-dev: " + metadata.stderr);
    const flags = metadata.stdout.trim().split(/\s+/);
    for (const compiler of ["gcc", "clang"]) {
      for (const [name, text, valid] of [
        ["verified", source, true],
        ["verification-disabled", source.replace("SSL_VERIFY_PEER", "SSL_VERIFY_NONE"), false],
        ["hostname-disabled", source.replace("SSL_set1_host(client, hostname)", "1"), false],
      ]) {
        const input = join(root, `${name}.c`);
        const binary = join(root, `${compiler}-${name}`);
        writeFileSync(input, text);
        const built = spawnSync(
          compiler,
          ["-O2", "-Wall", "-Wextra", "-Werror", input, ...flags, "-o", binary],
          { encoding: "utf8" },
        );
        assert.equal(built.status, 0, `${compiler}/${name}: ${built.stderr}`);
        const result = spawnSync(binary, [], { encoding: "utf8", timeout: 10_000 });
        assert.equal(result.error, undefined, `${compiler}/${name}: ${result.error}`);
        assert.equal(
          result.status,
          valid ? 0 : 1,
          `${compiler}/${name}: ${result.stdout}\n${result.stderr}`,
        );
        assert.equal(result.stdout.includes(stage), valid, name);
        if (valid) {
          for (const marker of [
            "TLS verification: trusted localhost TLSv1.3 binary roundtrip",
            "TLS verification: rejected localhost (18)",
            "TLS verification: rejected wrong.invalid (62)",
          ])
            assert.ok(result.stdout.split("\n").includes(marker), marker);
        }
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenSSL width, dependencies, ABI and installed consumers stay wired together", () => {
  const scope = readFileSync(new URL("../../default.nix", import.meta.url), "utf8");
  const override = scope.match(/openssl-wasm64 = self\.openssl\.override \{([\s\S]*?)\n    \};/);
  assert.ok(override);
  for (const name of ["stdenv", "platform", "musl", "llvm-runtimes", "busybox"])
    assert.ok(override[1].includes(`${name} = self.${name}-wasm64;`), name);
  assert.match(override[1], /vm-test = vmTestWasm64;/);
  const recipe = readFileSync(new URL("../package.nix", import.meta.url), "utf8");
  assert.ok(recipe.includes("linux-generic${toString platform.addressBits}"));
  assert.ok(
    recipe.includes(
      "apps/openssl ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}",
    ),
  );
  assert.match(recipe, /for program in handshake verified-handshake;/);
  assert.match(recipe, /cp handshake verified-handshake \$out\/bin\//);
  assert.match(recipe, /cp LICENSE.txt \$out\/share\/licenses\/openssl\/LICENSE.txt/);
  const script = readFileSync(new URL("./cli-test.sh", import.meta.url), "utf8");
  assert.ok(script.includes(stage));
  const syntax = spawnSync("sh", ["-n"], { input: script, encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test("browser and Node share the complete OpenSSL script and installed consumer outputs", () => {
  const recipe = readFileSync(new URL("../package.nix", import.meta.url), "utf8");
  assert.equal([...recipe.matchAll(/init = \.\/tests\/cli-test.sh;/g)].length, 1);
  assert.match(recipe, /passthru\.runtimeAssets =/);
  assert.match(recipe, /cliInitramfs = image\.mkInitramfs/);
  assert.match(recipe, /inherit init contents;/);
  assert.match(recipe, /inherit \(finalAttrs\.finalPackage\.runtimeAssets\) init contents;/);
  const browser = readFileSync(new URL("../../npm/browser-tests.nix", import.meta.url), "utf8");
  assert.ok(
    browser.includes(
      "opensslAssets = (if bits == 64 then openssl-wasm64 else openssl).runtimeAssets;",
    ),
  );
  assert.ok(browser.includes("cp ${opensslAssets.cliInitramfs} $out/runtime-openssl.cpio"));
  const script = readFileSync(new URL("./cli-test.sh", import.meta.url), "utf8");
  assert.match(script, /cat \/tmp\/verified-hsout/);
});
