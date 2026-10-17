// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
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

test("development metadata copies are writable without modifying read-only package inputs", () =>
  workspace((root) => {
    const packageRoot = join(root, "read-only package");
    const out = join(root, "development installation");
    const input = metadata(packageRoot);
    const output = join(out, "lib/pkgconfig");
    mkdirSync(output, { recursive: true });
    const originals = new Map(
      readdirSync(input).map((name) => [name, readFileSync(join(input, name))]),
    );
    for (const name of originals.keys()) chmodSync(join(input, name), 0o444);
    const recipe = readFileSync(new URL("../package.nix", import.meta.url), "utf8");
    const copy = recipe
      .split("\n")
      .find((line) => line.trim().startsWith('install -m644 "$package"/lib/pkgconfig/*.pc'));
    assert.ok(copy, "recipe must copy immutable metadata with an explicit writable mode");
    const installed = spawnSync("sh", ["-eu", "-c", copy], {
      env: { ...process.env, package: packageRoot, out },
      encoding: "utf8",
    });
    assert.equal(installed.status, 0, installed.stderr);
    for (const name of originals.keys())
      assert.equal(statSync(join(output, name)).mode & 0o777, 0o644);
    const relocated = spawnSync(process.execPath, [relocate, out, ...buildRoots], {
      encoding: "utf8",
    });
    assert.equal(relocated.status, 0, relocated.stderr);
    for (const [name, contents] of originals) {
      assert.equal(statSync(join(input, name)).mode & 0o777, 0o444);
      assert.deepEqual(readFileSync(join(input, name)), contents);
      assert.ok(readFileSync(join(output, name), "utf8").startsWith("prefix=${pcfiledir}/../.."));
    }
  }));

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

test("root-prefix redundant slashes relocate without accepting unrelated absolute directories", () =>
  workspace((root) => {
    const directory = metadata(root);
    const path = join(directory, "libcurl.pc");
    const original = readFileSync(path, "utf8");
    for (const slashes of ["/", "//", "///"]) {
      writeFileSync(
        path,
        original +
          `Libs.private: -L${slashes}lib -L${buildRoots[1]}${slashes}lib -lssl\n` +
          `Cflags.private: -I${slashes}include -I${buildRoots[2]}${slashes}include\n`,
      );
      const result = spawnSync(process.execPath, [relocate, root, ...buildRoots], {
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      const relocated = readFileSync(path, "utf8");
      assert.ok(relocated.includes("Libs.private: -L${libdir} -L${libdir} -lssl"));
      assert.ok(relocated.includes("Cflags.private: -I${includedir} -I${includedir}"));
      assert.doesNotMatch(relocated, /\/nix\/store\/|-[IL]\//);
    }
    for (const flag of [
      "-L//lib64",
      "-I//include-other",
      "-L/opt/lib",
      `-L${buildRoots[0]}/libevil`,
    ]) {
      const invalid = original + `Libs.private: ${flag}\n`;
      writeFileSync(path, invalid);
      const result = spawnSync(process.execPath, [relocate, root, ...buildRoots], {
        encoding: "utf8",
      });
      assert.notEqual(result.status, 0, flag);
      assert.ok(result.stderr.includes(`libcurl.pc\nLibs.private: ${flag}`), result.stderr);
      assert.equal(readFileSync(path, "utf8"), invalid);
    }
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
    3,
  );
  assert.doesNotMatch(source, /__wasm__|::vm-test::|while\s*\(1\)|sleep\(/);
  assert.equal(spawnSync("sh", ["-n"], { input: script }).status, 0);
});

test("installed CMake project builds the ordinary C consumer with GCC and Clang", () =>
  workspace((root) => {
    const original = join(root, "original");
    mkdirSync(original);
    writeFileSync(join(original, "fetch.c"), source);
    writeFileSync(
      join(original, "CMakeLists.txt"),
      readFileSync(new URL("../CMakeLists.txt", import.meta.url)),
    );
    const moved = join(root, "relocated");
    renameSync(original, moved);
    const nativeMetadata = join(root, "native-metadata");
    mkdirSync(nativeMetadata);
    const nativeFlags = (option) => {
      const result = spawnSync("pkg-config", [option, "libcurl"], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    // Real host libcurl may be shared. This fixture does not certify the target
    // static graph or require all host static dependency development packages.
    writeFileSync(
      join(nativeMetadata, "libcurl.pc"),
      `Name: native-libcurl-fixture\nDescription: Host consumer fixture only\nVersion: 1.0\nRequires.private: native-fixture-private\nLibs: ${nativeFlags("--libs")}\nCflags: ${nativeFlags("--cflags")}\n`,
    );
    writeFileSync(
      join(nativeMetadata, "native-fixture-private.pc"),
      "Name: native-fixture-private\nDescription: Native metadata dependency only\nVersion: 1.0\n",
    );
    const wrapper = join(root, "native-fixture-pkg-config");
    writeFileSync(
      wrapper,
      "#!/usr/bin/env bash\n" +
        readFileSync(new URL("../../sdk/pkg-config.sh", import.meta.url), "utf8")
          .replaceAll("@sysroot@", "/")
          // Native fixture only: explicitly select native metadata, not a target SDK.
          .replaceAll("@libdir@", `'${nativeMetadata}'`)
          .replaceAll("@pkgConfig@", "pkg-config"),
      { mode: 0o755 },
    );
    const env = { ...process.env, WASM_PKG_CONFIG_PATH: "", WASM_PKG_CONFIG_SYSROOT_DIR: "/" };
    const input = join(root, "input.bin");
    const bytes = Buffer.from([0, 1, 127, 128, 255, 10]);
    writeFileSync(input, bytes);
    for (const compiler of ["gcc", "clang"]) {
      const build = join(root, compiler);
      for (const args of [
        [
          "-S",
          moved,
          "-B",
          build,
          "-G",
          "Ninja",
          "-DCMAKE_BUILD_TYPE=Release",
          `-DCMAKE_C_COMPILER=${compiler}`,
          `-DPKG_CONFIG_EXECUTABLE=${wrapper}`,
        ],
        ["--build", build, "--verbose"],
      ]) {
        const result = spawnSync("cmake", args, { env, encoding: "utf8", timeout: 60_000 });
        assert.equal(result.status, 0, `${result.error || ""}\n${result.stdout}\n${result.stderr}`);
      }
      const binary = join(build, "libcurl-fetch.wasm");
      const result = spawnSync(binary, [`file://${input}`]);
      assert.equal(result.status, 0, result.stderr?.toString());
      assert.deepEqual(result.stdout, bytes);
      assert.equal(spawnSync(binary, []).status, 2);
    }
    unlinkSync(join(nativeMetadata, "native-fixture-private.pc"));
    const missing = spawnSync(
      "cmake",
      [
        "-S",
        moved,
        "-B",
        join(root, "missing-metadata"),
        "-G",
        "Ninja",
        `-DPKG_CONFIG_EXECUTABLE=${wrapper}`,
      ],
      { env, encoding: "utf8", timeout: 60_000 },
    );
    assert.notEqual(
      missing.status,
      0,
      "missing explicit private metadata must not use host libcurl",
    );
    assert.match(missing.stdout + missing.stderr, /native-fixture-private/);
  }));

test("CMake target consumer uses the copied project, SDK, staged libraries and shared runtime checks", () => {
  const recipe = readFileSync(new URL("../package.nix", import.meta.url), "utf8");
  const cmake = recipe
    .split("passthru.developmentCmakeApplication =")[1]
    .split("passthru.runtimeAssets")[0];
  assert.ok(
    recipe.includes("cp ${./CMakeLists.txt} $out/share/doc/libcurl/examples/CMakeLists.txt"),
  );
  assert.ok(cmake.includes("mv original relocated/installation"));
  assert.ok(cmake.includes("cmake -S relocated/installation/share/doc/libcurl/examples"));
  assert.ok(cmake.includes("-DCMAKE_TOOLCHAIN_FILE=${sdk}/share/cmake/linux-wasm.cmake"));
  assert.ok(cmake.includes('-DCMAKE_STAGING_PREFIX="$PWD/relocated/installation"'));
  assert.ok(cmake.includes("rm missing/lib/pkgconfig/libcrypto.pc"));
  assert.ok(cmake.includes("-B missing-build"));
  assert.ok(cmake.includes("grep -q libcrypto missing.log"));
  assert.ok(
    cmake.includes(
      "$out/bin/libcurl-fetch ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}",
    ),
  );
  assert.match(recipe, /development-cmake = vm-test\.installedTest/);
  assert.ok(recipe.includes("finalAttrs.finalPackage.developmentCmakeApplication"));
  const project = readFileSync(new URL("../CMakeLists.txt", import.meta.url), "utf8");
  assert.match(project, /pkg_check_modules\(LIBCURL REQUIRED IMPORTED_TARGET libcurl\)/);
  assert.match(project, /target_link_libraries\(libcurl-fetch PRIVATE PkgConfig::LIBCURL\)/);
  assert.doesNotMatch(project, /try_run|target_link_libraries[^\n]*-l/);
});

test("Node and browser share one installed C application script and matching outputs", () => {
  const recipe = readFileSync(new URL("../package.nix", import.meta.url), "utf8");
  assert.equal([...recipe.matchAll(/init = \.\/tests\/development-test.sh;/g)].length, 1);
  assert.match(recipe, /developmentInitramfs = image\.mkInitramfs/);
  assert.match(recipe, /inherit \(development\) init contents;/);
  assert.match(
    recipe,
    /inherit \(finalAttrs\.finalPackage\.runtimeAssets\.development\) init contents;/,
  );
  const browser = readFileSync(new URL("../../npm/browser-tests.nix", import.meta.url), "utf8");
  assert.ok(
    browser.includes("curlAssets = (if bits == 64 then curl-wasm64 else curl).runtimeAssets;"),
  );
  assert.ok(
    browser.includes("cp ${curlAssets.developmentInitramfs} $out/runtime-libcurl-development.cpio"),
  );
});
