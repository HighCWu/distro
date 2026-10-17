// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const relocate = fileURLToPath(new URL("../relocate-metadata.mjs", import.meta.url));
const source = readFileSync(new URL("../fetch-example.c", import.meta.url), "utf8");
const script = readFileSync(new URL("./development-test.sh", import.meta.url), "utf8");
const stage =
  "libcurl application: installed static client, file bytes, TLS trust and normal exits verified";

function workspace(run) {
  const root = mkdtempSync(join(tmpdir(), "linux-wasm-libcurl-dev-"));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const buildRoots = [
  "/nix/store/curl-fixture",
  "/nix/store/openssl-fixture",
  "/nix/store/zlib-fixture",
];
function metadata(root) {
  const directory = join(root, "lib/pkgconfig");
  mkdirSync(directory, { recursive: true });
  const declarations = {
    libcurl: `Requires.private: openssl zlib\nLibs: -L${buildRoots[0]}/lib -lcurl\nLibs.private: -L/lib -lssl -lcrypto -lz`,
    openssl: "Requires: libssl libcrypto",
    libssl: "Requires.private: libcrypto\nLibs: -L${libdir} -lssl",
    libcrypto: "Libs: -L${libdir} -lcrypto\nLibs.private: -pthread",
    zlib: "Libs: -L${libdir} -lz",
  };
  for (const [name, fields] of Object.entries(declarations))
    writeFileSync(
      join(directory, `${name}.pc`),
      `prefix=${buildRoots[0]}\nexec_prefix=\${prefix}\nlibdir=/lib\nincludedir=/include\nName: ${name}\nDescription: Native metadata fixture only\nVersion: 1.0\n${fields}\nCflags: -I/include\n`,
    );
  return directory;
}

test("copied libcurl metadata retains static dependencies, relocates twice and rejects native fallback", () =>
  workspace((root) => {
    const original = join(root, "original");
    metadata(original);
    const result = spawnSync(process.execPath, [relocate, original, ...buildRoots], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const empty = join(root, "empty");
    mkdirSync(empty);
    const query = (installation) =>
      spawnSync("pkg-config", ["--static", "--cflags", "--libs", "libcurl"], {
        encoding: "utf8",
        env: {
          ...process.env,
          PKG_CONFIG_PATH: join(installation, "lib/pkgconfig"),
          PKG_CONFIG_LIBDIR: empty,
          PKG_CONFIG_SYSROOT_DIR: "/",
          PKG_CONFIG_SYSTEM_INCLUDE_PATH: "",
          PKG_CONFIG_SYSTEM_LIBRARY_PATH: "",
        },
      });
    const moved = join(root, "moved");
    for (const installation of [original, moved]) {
      if (installation === moved) renameSync(original, moved);
      const flags = query(installation);
      assert.equal(flags.status, 0, flags.stderr);
      assert.ok(flags.stdout.includes(installation));
      assert.ok(!flags.stdout.includes("/nix/store/"));
      if (installation === moved) assert.ok(!flags.stdout.includes(original));
      for (const flag of ["-lcurl", "-lssl", "-lcrypto", "-lz", "-pthread"])
        assert.ok(flags.stdout.trim().split(/\s+/).includes(flag), flag);
      assert.ok(flags.stdout.indexOf("-lcurl") < flags.stdout.lastIndexOf("-lcrypto"));
    }
    unlinkSync(join(moved, "lib/pkgconfig/libcrypto.pc"));
    assert.notEqual(
      query(moved).status,
      0,
      "missing target dependency must not use host libcrypto",
    );
  }));

test("unknown build roots and absent static dependency metadata fail before rewriting", () =>
  workspace((root) => {
    const directory = metadata(root);
    const path = join(directory, "libcurl.pc");
    const original = readFileSync(path, "utf8") + "Unexpected: /nix/store/unknown-build-input\n";
    writeFileSync(path, original);
    assert.notEqual(spawnSync(process.execPath, [relocate, root, ...buildRoots]).status, 0);
    assert.equal(readFileSync(path, "utf8"), original);
    writeFileSync(path, original.replace("/nix/store/unknown-build-input", "no-path"));
    unlinkSync(join(directory, "openssl.pc"));
    assert.notEqual(spawnSync(process.execPath, [relocate, root, ...buildRoots]).status, 0);
  }));

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

test("installed C example uses real native libcurl binary I/O and TLS with GCC and Clang", async () => {
  const root = mkdtempSync(join(tmpdir(), "linux-wasm-libcurl-client-"));
  try {
    const flags = spawnSync("pkg-config", ["--cflags", "--libs", "libcurl"], { encoding: "utf8" });
    assert.equal(flags.status, 0, flags.stderr);
    const ca = spawnSync("curl-config", ["--ca"], { encoding: "utf8" });
    assert.equal(ca.status, 0, ca.stderr);
    const originalCa = readFileSync(ca.stdout.trim());
    const notices = join(root, "notices");
    mkdirSync(notices);
    for (const license of [
      "curl-COPYING",
      "integration-MIT",
      "zlib.h",
      "openssl-LICENSE.txt",
      "musl-COPYRIGHT",
      "compiler-rt-LICENSE.TXT",
      "example-MIT",
    ])
      writeFileSync(join(notices, license), `Native fixture notice: ${license}\n`);
    for (const compiler of ["gcc", "clang"])
      for (const [name, cSource, transform, valid] of [
        ["verified", source, (text) => text, true],
        [
          "insecure",
          source
            .replace("CURLOPT_SSL_VERIFYPEER, 1L", "CURLOPT_SSL_VERIFYPEER, 0L")
            .replace("CURLOPT_SSL_VERIFYHOST, 2L", "CURLOPT_SSL_VERIFYHOST, 0L"),
          (text) => text,
          false,
        ],
        [
          "hostname-disabled",
          source.replace("CURLOPT_SSL_VERIFYHOST, 2L", "CURLOPT_SSL_VERIFYHOST, 0L"),
          (text) => text,
          false,
        ],
        [
          "wrong-ca-accepted",
          source,
          (text) =>
            text.replace(
              'request localhost "$root/unrelated.pem"',
              'request localhost "$root/server.pem"',
            ),
          false,
        ],
      ]) {
        const prefix = join(root, `${compiler}-${name}`);
        const cPath = `${prefix}.c`,
          binary = `${prefix}.bin`,
          caPath = `${prefix}-ca.pem`;
        writeFileSync(cPath, cSource);
        const build = spawnSync(
          compiler,
          [
            "-O2",
            "-Wall",
            "-Wextra",
            "-Werror",
            cPath,
            ...flags.stdout.trim().split(/\s+/),
            "-o",
            binary,
          ],
          { encoding: "utf8" },
        );
        assert.equal(build.status, 0, build.stderr);
        writeFileSync(caPath, originalCa);
        const port = await freePort();
        // Native builds do NOT certify the compiled target CA default. Supply
        // the temporary CA explicitly for that one fixture request instead.
        const adapted = transform(script)
          .replace("root=/tmp/libcurl-application", `root=${prefix}`)
          .replace("default_ca=/etc/ssl/cert.pem", `default_ca=${caPath}`)
          .replace("port=9445", `port=${port}`)
          .replace("mount -t proc proc /proc", ":")
          .replace("ip link set lo up", ":")
          .replaceAll("/share/licenses/curl/", `${notices}/`)
          .replaceAll("/bin/libcurl-fetch", binary)
          .replace("request localhost -", 'request localhost "$default_ca"')
          .replace(/while :; do :; done\s*$/, "exit 0\n")
          .replace("while :; do :; done", "exit 1");
        const result = spawnSync("sh", ["-eu", "-c", adapted], {
          encoding: "utf8",
          timeout: 30_000,
        });
        assert.equal(result.error, undefined, `${compiler}/${name}: ${result.error}`);
        assert.equal(
          result.status,
          valid ? 0 : 1,
          `${compiler}/${name}: ${result.stdout}\n${result.stderr}`,
        );
        assert.equal(result.stdout.includes(stage), valid);
        assert.equal(/^::vm-test::pass$/m.test(result.stdout), valid);
        assert.deepEqual(readFileSync(caPath), originalCa, "native fixture trust restored");
        if (valid) {
          for (const marker of [
            "binary file callback and normal exit verified",
            "explicit CA TLS1.3 over Linux TCP verified",
            "default CA TLS1.3 verified",
            "explicit untrusted CA rejected despite trusted default",
            "wrong hostname rejected",
          ])
            assert.ok(result.stdout.includes(`libcurl application: ${marker}`), marker);
          const missing = spawnSync(binary, [`file://${root}/missing-input`], { encoding: "utf8" });
          assert.equal(missing.status, 37);
          assert.match(missing.stderr, /libcurl error: 37 /);
          assert.equal(spawnSync(binary, []).status, 2);
        }
      }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("both widths use installed example, SDK flags, ABI guard and complete notices", () => {
  const recipe = readFileSync(new URL("../package.nix", import.meta.url), "utf8");
  const scope = readFileSync(new URL("../../default.nix", import.meta.url), "utf8");
  assert.match(
    scope.match(/curl-wasm64 = self\.curl\.override \{([\s\S]*?)\n    \};/)[1],
    /sdk = self\.sdk-wasm64;/,
  );
  assert.ok(
    recipe.includes("cp relocated/installation/share/doc/libcurl/examples/fetch.c fetch.c"),
  );
  assert.ok(recipe.includes("mv original relocated/installation"));
  assert.ok(recipe.includes("wasm-linux-pkg-config --libs libcurl"));
  assert.ok(
    recipe.includes(
      "$out/bin/libcurl-fetch ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}",
    ),
  );
  assert.match(recipe, /development = vm-test\.installedTest/);
  assert.ok(recipe.includes("$out/share/licenses/curl/example-MIT"));
  assert.equal(
    [...recipe.matchAll(/passthru\.apk\.license = finalAttrs\.passthru\.apk\.license;/g)].length,
    2,
  );
  assert.doesNotMatch(source, /__wasm__|::vm-test::|while\s*\(1\)|sleep\(/);
  assert.equal(spawnSync("sh", ["-n"], { input: script }).status, 0);
});
