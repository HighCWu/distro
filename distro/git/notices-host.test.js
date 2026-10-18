// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const regexFiles = [
  "regcomp.c",
  "regex.c",
  "regex.h",
  "regex_internal.c",
  "regex_internal.h",
  "regexec.c",
];
const curlFiles = [
  "curl-COPYING",
  "zlib.h",
  "openssl-LICENSE.txt",
  "musl-COPYRIGHT",
  "compiler-rt-LICENSE.TXT",
  "integration-MIT",
];
const installer = fileURLToPath(new URL("./install-notices.sh", import.meta.url));
const checker = readFileSync(new URL("./notice-check.sh", import.meta.url), "utf8");

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "linux-wasm-git-notices-"));
  try {
    const source = join(root, "source");
    const curl = join(root, "curl");
    const output = join(root, "output");
    const installed = join(output, "usr/share/licenses/git");
    const inputs = new Map();
    function input(path, name, bytes = Buffer.from(`original fixture bytes for ${name}\n`)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
      inputs.set(name, { path, bytes });
    }
    input(join(source, "COPYING"), "git-COPYING");
    input(join(source, "sha1dc/LICENSE.txt"), "sha1dc-LICENSE.txt");
    input(join(source, "reftable/LICENSE"), "reftable-LICENSE");
    for (const name of regexFiles)
      input(join(source, "compat/regex", name), `compat-regex/${name}`);
    for (const name of curlFiles) input(join(curl, "share/licenses/curl", name), `linked/${name}`);
    const extra = ["notices.md", "run-command-posix-spawn.patch", "../sdk/LICENSE.MIT"].map(
      (path) => fileURLToPath(new URL(path, import.meta.url)),
    );
    for (const [index, name] of [
      "README.md",
      "run-command-posix-spawn.patch",
      "notice-tools-MIT",
    ].entries()) {
      input(join(root, name), name, readFileSync(extra[index]));
    }
    const install = () =>
      spawnSync(
        "bash",
        [
          installer,
          source,
          curl,
          output,
          ...["README.md", "run-command-posix-spawn.patch", "notice-tools-MIT"].map((name) =>
            join(root, name),
          ),
        ],
        { encoding: "utf8", timeout: 10000 },
      );
    const check = () =>
      spawnSync("sh", ["-c", checker.replace("cd /usr/share/licenses/git", `cd '${installed}'`)], {
        encoding: "utf8",
        timeout: 5000,
      });
    run({ root, source, curl, output, installed, inputs, install, check });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("actual Git notice installer preserves original read-only inputs, patch and selected dependency bytes", () => {
  fixture(({ inputs, installed, install, check, root }) => {
    for (const { path } of inputs.values()) chmodSync(path, 0o444);
    const result = install();
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    for (const [name, { path, bytes }] of inputs) {
      assert.deepEqual(readFileSync(join(installed, name)), bytes, name);
      assert.deepEqual(readFileSync(path), bytes, "never modify the source");
    }
    assert.equal(check().status, 0);
    const bin = join(root, "bin");
    mkdirSync(bin);
    symlinkSync("/usr/bin/busybox", join(bin, "sha256sum"));
    const busybox = spawnSync(
      "/usr/bin/busybox",
      ["sh", "-c", checker.replace("cd /usr/share/licenses/git", `cd '${installed}'`)],
      { env: { ...process.env, PATH: bin }, encoding: "utf8", timeout: 5000 },
    );
    assert.equal(busybox.status, 0, busybox.error?.message ?? busybox.stderr);
  });
});

test("every missing or empty selected input rejects the actual Git notice installation", () => {
  const names = [];
  fixture(({ inputs }) => names.push(...inputs.keys()));
  for (const name of names) {
    for (const damage of ["missing", "empty"]) {
      fixture(({ inputs, install }) => {
        const { path } = inputs.get(name);
        if (damage === "missing") rmSync(path);
        else writeFileSync(path, "");
        const result = install();
        assert.notEqual(result.status, 0, `${name}: ${damage}`);
        assert.equal(result.signal, null, result.error?.message);
      });
    }
  }
});

test("actual installed Git notice checker rejects missing, empty and changed files and missing manifests", () => {
  fixture(({ inputs, installed, install, check }) => {
    const result = install();
    assert.equal(result.status, 0, result.stderr);
    for (const [name, { bytes }] of inputs) {
      const path = join(installed, name);
      for (const damage of ["missing", "empty", "changed"]) {
        if (damage === "missing") rmSync(path);
        else writeFileSync(path, damage === "empty" ? "" : "changed notice\n");
        assert.notEqual(check().status, 0, `${name}: ${damage}`);
        writeFileSync(path, bytes);
      }
    }
    const path = join(installed, "SHA256SUMS");
    writeFileSync(path, "");
    assert.notEqual(check().status, 0);
    rmSync(path);
    assert.notEqual(check().status, 0);
  });
});

test("Git packages install and check the same selected notices in all three runtime fixtures", () => {
  const recipe = readFileSync(new URL("./package.nix", import.meta.url), "utf8");
  assert.match(recipe, /meta.license = pkgs.lib.licenses.gpl2Only;/);
  assert.ok(
    recipe.includes(
      'bash ${./install-notices.sh} . ${curl} "$out" ${./notices.md} \\\n      ${./run-command-posix-spawn.patch} ${../sdk/LICENSE.MIT}',
    ),
  );
  assert.ok(recipe.includes('files."/git-notice-check.sh" = ./notice-check.sh;'));
  assert.ok(recipe.includes('files."/git-runtime-check.sh" = ./runtime-check.sh;'));
  assert.ok(recipe.includes('files."/git-address-bits" = pkgs.writeText "git-address-bits"'));
  assert.ok(recipe.includes('toString platform.addressBits + "\\n"'));
  for (const name of ["workflow", "packing", "remote"]) {
    const script = readFileSync(new URL(`./${name}-test.sh`, import.meta.url), "utf8");
    const mount = script.indexOf("mount -t devtmpfs devtmpfs /dev || fail");
    const preflight = script.indexOf("/bin/sh /git-runtime-check.sh || fail");
    assert.ok(mount >= 0 && preflight > mount, "Git preflight requires initialized /dev/null");
    if (name === "remote") {
      assert.ok(preflight > script.indexOf("/vm-test-setup-dev-fd || fail"));
    }
    assert.ok(
      script.includes(
        '/bin/sh /git-runtime-check.sh || fail "Git runtime width or selected notices invalid"',
      ),
    );
  }
});

test("actual Git runtime preflight requires matching long/size_t, notices and successful Git execution", () => {
  fixture(({ root, installed, install }) => {
    const result = install();
    assert.equal(result.status, 0, result.stderr);
    const bin = join(root, "bin");
    mkdirSync(bin);
    for (const name of ["grep", "sha256sum"]) symlinkSync("/usr/bin/busybox", join(bin, name));
    const git = join(bin, "git");
    writeFileSync(git, '#!/bin/sh\nprintf "%s\\n" "$GIT_BUILD_OPTIONS"\nexit "${GIT_STATUS:-0}"\n');
    chmodSync(git, 0o755);
    const bitsPath = join(root, "bits");
    const noticePath = join(root, "notice-check.sh");
    writeFileSync(noticePath, checker.replace("cd /usr/share/licenses/git", `cd '${installed}'`));
    const runtime = readFileSync(new URL("./runtime-check.sh", import.meta.url), "utf8");
    assert.doesNotMatch(runtime, /^\s*set\s+[^\n]*-[^\n]*u/m);
    const script = runtime
      .replaceAll("/git-address-bits", bitsPath)
      .replace("/bin/sh /git-notice-check.sh", `/bin/sh '${noticePath}'`);
    const run = (options, status = "0") =>
      spawnSync("/bin/sh", ["-c", script], {
        env: { ...process.env, PATH: bin, GIT_BUILD_OPTIONS: options, GIT_STATUS: status },
        encoding: "utf8",
        timeout: 5000,
      });
    for (const bits of [32, 64]) {
      writeFileSync(bitsPath, `${bits}\n`);
      const size = bits / 8;
      const valid = `git version 2.55.0\nsizeof-long: ${size}\nsizeof-size_t: ${size}`;
      const good = run(valid);
      assert.equal(good.status, 0, good.error?.message ?? good.stderr);
      assert.ok(good.stdout.includes(`Git ABI: long and size_t match ${bits} bits`));
      assert.ok(
        good.stdout.includes(
          "Git notices: selected installed originals and default patch checksums verified",
        ),
      );
      for (const bad of [
        valid.replace(`sizeof-long: ${size}`, ""),
        valid.replace(`sizeof-size_t: ${size}`, ""),
        valid.replace(`sizeof-long: ${size}`, `sizeof-long: ${size === 4 ? 8 : 4}`),
        valid.replace(`sizeof-size_t: ${size}`, `sizeof-size_t: ${size === 4 ? 8 : 4}`),
      ]) {
        assert.notEqual(run(bad).status, 0);
      }
      assert.notEqual(run(valid, "7").status, 0);
    }
    for (const invalid of ["", "16\n", "64 trailing\n"]) {
      writeFileSync(bitsPath, invalid);
      assert.notEqual(run("sizeof-long: 8\nsizeof-size_t: 8").status, 0);
    }
    writeFileSync(bitsPath, "64\n");
    writeFileSync(join(installed, "git-COPYING"), "changed\n");
    const changed = run("sizeof-long: 8\nsizeof-size_t: 8");
    assert.notEqual(changed.status, 0);
    assert.ok(
      !changed.stdout.includes(
        "Git notices: selected installed originals and default patch checksums verified",
      ),
    );
  });
});
