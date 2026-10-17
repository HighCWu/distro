// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("shared target site policy only supplies established negative capability answers", () => {
  const path = fileURLToPath(new URL("../config.site", import.meta.url));
  const fields = [
    "ac_cv_func_fork",
    "ac_cv_func_vfork",
    "ac_cv_func_fork_works",
    "ac_cv_func_vfork_works",
    "ac_cv_func_mmap_fixed_mapped",
    "ac_cv_func_dlopen",
    "ac_cv_search_dlopen",
    "ac_cv_lib_dl_dlopen",
    "ac_cv_func_sigaltstack",
  ];
  const script =
    'source "$1"; shift; for field in "$@"; do printf "%s=%s\\n" "$field" "${!field}"; done';
  const result = spawnSync(
    "bash",
    [
      "-eu",
      "-c",
      script,
      "policy",
      path,
      ...fields,
      "ac_cv_func_unverified_feature",
      "ac_cv_func_mmap",
      "ac_cv_func_msync",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        ac_cv_func_unverified_feature: "untouched",
        ac_cv_func_mmap: "probe",
        ac_cv_func_msync: "probe",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    fields.map((name) => `${name}=no\n`).join("") +
      "ac_cv_func_unverified_feature=untouched\nac_cv_func_mmap=probe\nac_cv_func_msync=probe\n",
  );
  const policy = readFileSync(path, "utf8");
  assert.deepEqual(
    policy
      .split("\n")
      .filter((line) => /^ac_cv_/.test(line))
      .sort(),
    fields.map((name) => `${name}=no`).sort(),
  );
});

test("distro, installed SDK and profile use the same site policy source", () => {
  const stdenv = readFileSync(new URL("../stdenv.nix", import.meta.url), "utf8");
  assert.match(stdenv, /configSite = \.\/config\.site;/);
  const sdk = readFileSync(new URL("./package.nix", import.meta.url), "utf8");
  assert.match(sdk, /builtins\.readFile \.\.\/config\.site/);
  assert.ok(sdk.includes('configSite = "${configSiteFiles}/share/linux-wasm-sdk/config.site";'));
  assert.ok(sdk.includes("SDK_TEST_CONFIG_SITE=${sdk}/share/linux-wasm-sdk/config.site"));
  const wrapper = readFileSync(new URL("./configure.sh", import.meta.url), "utf8");
  assert.match(wrapper, /sdk_config_site=@configSite@/);
  assert.ok(wrapper.includes('export CONFIG_SITE="${WASM_CONFIG_SITE:-$sdk_config_site}"'));
  const hostSyntax = spawnSync("bash", ["-n"], { input: wrapper, encoding: "utf8" });
  assert.equal(hostSyntax.status, 0, hostSyntax.stderr);
});
