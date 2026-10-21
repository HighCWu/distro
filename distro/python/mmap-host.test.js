// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("Python anonymous buffer fixture runs on the native interpreter", () => {
  const result = spawnSync("python3", [fileURLToPath(new URL("./mmap-test.py", import.meta.url))], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /private anonymous bytes, buffer lifetime and close verified/);
  assert.match(
    result.stdout,
    /resize growth, shrink, zero tail, exported buffers and error recovery verified/,
  );
  assert.doesNotMatch(result.stdout, /default shared and file mappings rejected/);
});

test("target fixture requires explicit kernel rejection checks, without overriding mmap probes", () => {
  const recipe = readFileSync(new URL("./package.nix", import.meta.url), "utf8");
  assert.doesNotMatch(
    recipe,
    /py_cv_module_mmap=|ac_cv_func_mmap_fixed_mapped=yes|ac_cv_func_mremap=/,
  );
  assert.match(recipe, /mmap = vm-test\.installedTest/);
  assert.ok(recipe.includes("grep -qx '#define HAVE_MREMAP 1'"));
  assert.ok(recipe.includes("grep -qx '#define HAVE_MADVISE 1'"));
  assert.ok(recipe.includes('files."/mmap-test.py" = ./mmap-test.py;'));
  const script = readFileSync(new URL("./mmap-test.sh", import.meta.url), "utf8");
  assert.match(script, /python3 \/mmap-test.py --kernel-boundaries; then/);
  assert.match(script, /python3 \/python-abi-test.py "\$\(cat \/python-address-bits\)"/);
  assert.equal(spawnSync("sh", ["-n"], { input: script }).status, 0);
  const browser = readFileSync(
    new URL("../../packages/browser-tests/python-tests/python.spec.js", import.meta.url),
    "utf8",
  );
  assert.match(
    browser,
    /Python mmap: resize growth, shrink, zero tail, exported buffers and error recovery verified/,
  );
});

for (const mode of ["noop", "lost-prefix", "ignored-error", "stale-pages"])
  test(`Python resize fixture rejects ${mode}`, () => {
    const fixture = fileURLToPath(new URL("./mmap-test.py", import.meta.url));
    const source = `
import mmap, runpy, sys
namespace = runpy.run_path(sys.argv[1])
mode = sys.argv[2]
class BrokenMapping(mmap.mmap):
    def resize(self, size):
        old = len(self)
        if mode == "noop" or (mode == "ignored-error" and size == 0):
            return None
        saved = self[size:] if mode == "stale-pages" and 0 < size < old else None
        result = super().resize(size)
        if mode == "lost-prefix" and size > old:
            self[0] ^= 1
        if mode == "stale-pages":
            if size > old and hasattr(self, "discarded"):
                data = self.discarded[:size-old]
                self[old:old+len(data)] = data
            if saved is not None:
                self.discarded = saved
        return result
def broken(size):
    return BrokenMapping(-1, size, flags=mmap.MAP_PRIVATE, prot=mmap.PROT_READ | mmap.PROT_WRITE)
exercise = namespace["exercise_resize"]
exercise.__globals__["private_mapping"] = broken
exercise()
`;
    const result = spawnSync("python3", ["-c", source, fixture, mode], {
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /AssertionError/);
    assert.doesNotMatch(result.stdout, /error recovery verified/);
  });

for (const mode of ["noop", "wrong-range"])
  test(`Python madvise rejects ${mode}`, () => {
    const fixture = fileURLToPath(new URL("./mmap-test.py", import.meta.url));
    const source = `
import mmap, runpy, sys
namespace = runpy.run_path(sys.argv[1])
mode = sys.argv[2]
class BrokenMapping(mmap.mmap):
    def madvise(self, advice, *args):
        if mode == "noop": return None
        return super().madvise(advice)
def broken(size):
    return BrokenMapping(-1, size, flags=mmap.MAP_PRIVATE, prot=mmap.PROT_READ | mmap.PROT_WRITE)
exercise = namespace["exercise_advice"]
exercise.__globals__["private_mapping"] = broken
exercise()
`;
    const run = spawnSync("python3", ["-c", source, fixture, mode], {
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(run.error, undefined);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /AssertionError/);
    assert.doesNotMatch(run.stdout, /rejects invalid advice/);
  });

for (const mode of ["false-success", "discard-data"])
  test(`Python private flush rejects ${mode}`, () => {
    const fixture = fileURLToPath(new URL("./mmap-test.py", import.meta.url));
    const source = `
import mmap, runpy, sys
namespace = runpy.run_path(sys.argv[1])
mode = sys.argv[2]
class BrokenMapping(mmap.mmap):
    def flush(self, *args):
        if mode == "false-success":
            return None
        result = super().flush(*args)
        self[0] ^= 1
        return result
def broken(size):
    return BrokenMapping(-1, size, flags=mmap.MAP_PRIVATE, prot=mmap.PROT_READ | mmap.PROT_WRITE)
exercise = namespace["exercise_flush"]
exercise.__globals__["private_mapping"] = broken
exercise()
`;
    const run = spawnSync("python3", ["-c", source, fixture, mode], {
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(run.error, undefined);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /AssertionError/);
    assert.doesNotMatch(run.stdout, /without file writeback/);
  });
