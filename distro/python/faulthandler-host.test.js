// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const fixture = fileURLToPath(new URL("./faulthandler-test.py", import.meta.url));
test("unchanged native CPython accepts signal-stack consumer and rejects disabled capabilities", () => {
  for (const mode of ["normal", "no-startup", "no-feature"]) {
    const args = ["-B"];
    if (mode !== "no-startup") args.push("-X", "faulthandler");
    if (mode === "no-feature")
      args.push(
        "-c",
        "import runpy,sys,sysconfig; sysconfig.get_config_vars()['HAVE_SIGALTSTACK']=0; runpy.run_path(sys.argv[1],run_name='__main__')",
      );
    args.push(fixture);
    const run = spawnSync("python3", args, { encoding: "utf8", timeout: 15000 });
    assert.equal(run.error, undefined);
    if (mode === "normal") {
      assert.equal(run.status, 0, run.stdout + run.stderr);
      assert.equal((run.stdout.match(/Python faulthandler: .* pass/g) ?? []).length, 3);
    } else {
      assert.notEqual(run.status, 0);
      assert.match(run.stderr, /AssertionError/);
      assert.doesNotMatch(run.stdout, /Python faulthandler:/);
    }
  }
});

test("target faulthandler uses normal configuration, installed ABI and upstream handlers", () => {
  const recipe = readFileSync(new URL("./package.nix", import.meta.url), "utf8");
  assert.match(recipe, /grep -qx '#define HAVE_SIGALTSTACK 1' pyconfig\.h/);
  assert.match(recipe, /faulthandler = vm-test\.installedTest \{/);
  assert.match(recipe, /init = \.\/faulthandler-test\.sh;/);
  const init = readFileSync(new URL("./faulthandler-test.sh", import.meta.url), "utf8");
  assert.match(
    init,
    /python3 \/python-abi-test\.py "\$\(cat \/python-address-bits\)" --installed-layout &&/,
  );
  assert.match(init, /python3 -X faulthandler \/faulthandler-test\.py/);
  assert.doesNotMatch(
    readFileSync(new URL("../config.site", import.meta.url), "utf8"),
    /^ac_cv_func_sigaltstack=/m,
  );
  assert.doesNotMatch(recipe, /ac_cv_func_sigaltstack=yes|-DHAVE_SIGALTSTACK/);
});
