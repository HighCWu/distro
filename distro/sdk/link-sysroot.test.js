// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("link sysroot writes and installs mode-specific response files", () => {
  const helper = readFileSync(new URL("./link-sysroot.nix", import.meta.url), "utf8");
  const cxxConfig = readFileSync(new URL("../llvm-toolchain/clang++.cfg", import.meta.url), "utf8");

  assert.match(helper, /lib\.concatMapStringsSep "\\n" lib\.escapeShellArg args/);
  assert.match(
    helper,
    /pkgs\.writeText "\$\{name\}-wasm-linux-executable\.rsp" \(\s*responseText executableArgs\s*\)/,
  );
  assert.match(
    helper,
    /sharedResponse =\s*if sharedArgs == null then\s*null\s*else\s*pkgs\.writeText "\$\{name\}-wasm-linux-shared\.rsp" \(responseText sharedArgs\)/,
  );
  assert.match(helper, /cxxArgs \? \[ "-lunwind" \]/);
  assert.match(helper, /pkgs\.writeText "\$\{name\}-wasm-linux-cxx\.rsp" \(responseText cxxArgs\)/);

  assert.match(helper, /cp -rs \$\{sysroot\}\/\. \$out\//);
  assert.match(helper, /ln -s \$\{executableResponse\} \$out\/lib\/wasm-linux-executable\.rsp/);
  assert.match(helper, /ln -s \$\{sharedResponse\} \$out\/lib\/wasm-linux-shared\.rsp/);
  assert.match(helper, /ln -s \$\{cxxResponse\} \$out\/lib\/wasm-linux-cxx\.rsp/);

  assert.match(cxxConfig, /^-stdlib=libc\+\+$/m);
  assert.match(cxxConfig, /^\$--unwindlib=libunwind$/m);
  assert.match(cxxConfig, /^-fwasm-exceptions$/m);
  assert.match(cxxConfig, /^-fc\+\+-abi=webassembly$/m);
  assert.doesNotMatch(cxxConfig, /^(?:--unwindlib=|-lunwind)$/m);
});
