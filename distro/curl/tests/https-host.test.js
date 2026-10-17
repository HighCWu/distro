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
const defaultStages = [
  "curl HTTPS: distribution CA bundle rejects local self-signed certificate",
  "curl HTTPS: default CA bundle trusted localhost TLS1.3 over Linux TCP verified",
  "curl HTTPS: unrelated default CA rejected",
  "curl HTTPS: missing default CA bundle fails closed",
  "curl HTTPS: original distribution CA bundle restored",
];

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

test("native curl verifies TLS trust selection and rejects insecure/default/explicit trust mutations", async () => {
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
      [
        "verification-disabled",
        (text) => text.replace("curl --silent", "curl --insecure --silent"),
        false,
      ],
      [
        "trust-negative-accepted",
        (text) =>
          text.replace(
            'request localhost --cacert "$root/unrelated.pem"',
            'request localhost --cacert "$root/server.pem"',
          ),
        false,
      ],
      [
        "hostname-negative-accepted",
        (text) =>
          text.replace(
            'request wrong.invalid --cacert "$root/server.pem"',
            'request localhost --cacert "$root/server.pem"',
          ),
        false,
      ],
      [
        "default-trust-ignored",
        (text) => text.replace('cp "$root/server.pem" "$default_ca"', ":"),
        false,
      ],
      [
        "default-negative-accepted",
        (text) =>
          text.replace(
            'cp "$root/unrelated.pem" "$default_ca"',
            'cp "$root/server.pem" "$default_ca"',
          ),
        false,
      ],
      [
        "missing-default-accepted",
        (text) => text.replace('rm "$default_ca"', 'cp "$root/server.pem" "$default_ca"'),
        false,
      ],
      [
        "explicit-trust-ignored",
        (text) => text.replace('    "$@" --resolve', "    --resolve"),
        false,
      ],
    ]) {
      const port = await freePort();
      const caPath = join(directory, `${name}-default-ca.pem`);
      // Never edit the host trust store. Native curl uses an environment-selected
      // copy; only target CI can certify the compiled /etc/ssl/cert.pem default.
      const ca = spawnSync("curl-config", ["--ca"], { encoding: "utf8" });
      assert.equal(ca.status, 0, ca.stderr);
      const originalCa = readFileSync(ca.stdout.trim());
      writeFileSync(caPath, originalCa);
      const adapted = transform(script)
        .replace("root=/tmp/curl-tls", `root=${directory}/${name}`)
        .replace("port=9443", `port=${port}`)
        .replace("default_ca=/etc/ssl/cert.pem", `default_ca=${caPath}`)
        .replace(
          "unset CURL_CA_BUNDLE SSL_CERT_FILE SSL_CERT_DIR",
          'unset SSL_CERT_FILE SSL_CERT_DIR; export CURL_CA_BUNDLE="$default_ca"',
        )
        .replace('[ "$(curl-config --ca)" = "$default_ca" ]', "true")
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
      assert.deepEqual(readFileSync(caPath), originalCa, `${name}: host fixture CA restored`);
      if (valid)
        for (const marker of [
          ...defaultStages,
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
  assert.ok(recipe.includes('"--with-ca-bundle=/etc/ssl/cert.pem"'));
  assert.doesNotMatch(recipe, /--without-ca-bundle/);
  assert.ok(script.includes("unset CURL_CA_BUNDLE SSL_CERT_FILE SSL_CERT_DIR"));
  assert.ok(script.includes('[ "$(curl-config --ca)" = "$default_ca" ]'));
  const transfers = readFileSync(new URL("./transfers-test.sh", import.meta.url), "utf8");
  assert.ok(transfers.includes('[ "$(curl-config --ca)" = /etc/ssl/cert.pem ]'));
  const ca = readFileSync(new URL("../../ca-certificates/package.nix", import.meta.url), "utf8");
  assert.ok(ca.includes("$out/etc/ssl/cert.pem"));
  assert.ok(script.includes(stage));
  assert.doesNotMatch(script, /--insecure|--proxy |sleep /);
  const syntax = spawnSync("sh", ["-n"], { input: script, encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test("browser HTTPS reuses the Node script and matching installed curl/OpenSSL outputs", () => {
  const recipe = readFileSync(new URL("../package.nix", import.meta.url), "utf8");
  assert.equal([...recipe.matchAll(/init = \.\/tests\/https-test.sh;/g)].length, 1);
  assert.match(recipe, /passthru\.runtimeAssets = rec \{/);
  assert.match(recipe, /httpsInitramfs = image\.mkInitramfs/);
  assert.match(recipe, /inherit init contents;/);
  assert.match(recipe, /inherit \(finalAttrs\.finalPackage\.runtimeAssets\) init contents;/);
  const browser = readFileSync(new URL("../../npm/browser-tests.nix", import.meta.url), "utf8");
  assert.ok(
    browser.includes("curlAssets = (if bits == 64 then curl-wasm64 else curl).runtimeAssets;"),
  );
  assert.ok(browser.includes("cp ${curlAssets.httpsInitramfs} $out/runtime-curl-https.cpio"));
});
