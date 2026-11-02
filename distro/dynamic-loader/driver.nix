# SPDX-License-Identifier: MIT
{ pkgs, compiler }:
let
  artifact =
    pkgs.runCommand "linux-wasm-shared-driver"
      {
        nativeBuildInputs = [
          compiler
          pkgs.python3
          pkgs.nodejs
        ];
      }
      ''
        mkdir $out
        python3 ${./driver.py} ${compiler}/bin/clang $out
        node ${./driver.mjs} ${../../packages/kernel/src/wasm_binary.ts} $out
        cp ${./driver.py} ${./driver.mjs} $out/
        mkdir -p $out/licenses
        cp ${../sdk/LICENSE.MIT} $out/licenses/probes-MIT
        cp ${compiler.src}/llvm/LICENSE.TXT $out/licenses/LLVM-LICENSE.TXT
      '';
in
artifact.overrideAttrs (_old: {
  passthru.checks.build =
    pkgs.runCommand "linux-wasm-shared-driver-check"
      {
        passthru.ci.heavy = true;
      }
      ''
        test -f ${artifact}/wasm32-side.wasm
        test -f ${artifact}/wasm64-side.wasm
        touch $out
      '';
})
