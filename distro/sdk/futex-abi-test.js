// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Native register ABIs may hide narrow or missing variadic arguments. Check
// expression types and arity before C's implicit parameter conversions instead.
// This is a compile-only fixture contract, not a target ABI/runtime test.
const guard = `
#define _GNU_SOURCE
#include <unistd.h>
#define ABI_WORD(value) \\
  ((void)sizeof(char[_Generic((value), long: 1, default: -1)]), (value))
#define syscall(number, a, b, c, d, e, f) \\
  syscall(number, ABI_WORD(a), ABI_WORD(b), ABI_WORD(c), \\
    ABI_WORD(d), ABI_WORD(e), ABI_WORD(f))
`;

for (const fixture of ["futex", "signal-futex"]) {
  const source = fileURLToPath(new URL(`../basic-init/tests/${fixture}.c`, import.meta.url));
  const original = readFileSync(source, "utf8");
  for (const compiler of ["gcc", "clang"]) {
    test(`${fixture} syscall arguments are six machine words with ${compiler}`, () => {
      const compile = (input) => {
        const result = spawnSync(
          compiler,
          [
            "-std=c11",
            "-pthread",
            "-Wall",
            "-Wextra",
            "-Werror",
            "-fsyntax-only",
            "-iquote",
            dirname(source),
            "-x",
            "c",
            "-",
          ],
          { input: guard + input, encoding: "utf8", timeout: 30000, cwd: tmpdir() },
        );
        assert.ifError(result.error);
        return result;
      };
      const valid = compile(original);
      assert.equal(valid.status, 0, valid.stderr);

      const narrow = original.replace("0L", "0");
      assert.notEqual(narrow, original);
      const rejectedWidth = compile(narrow);
      assert.notEqual(rejectedWidth.status, 0, "narrow int argument escaped the ABI gate");
      assert.match(rejectedWidth.stderr, /negative|array size/);

      const missing = original.replace(", 0L, 0L);", ", 0L);");
      assert.notEqual(missing, original);
      const rejectedArity = compile(missing);
      assert.notEqual(rejectedArity.status, 0, "missing argument escaped the ABI gate");
      assert.match(rejectedArity.stderr, /arguments|requires/);
    });
  }
}
