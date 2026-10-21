# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  sdk-fork-continuation,
  vm-test,
}:
assert platform.addressBits == 32;
let
  probe =
    pkgs.runCommand "fork-high-layout-wasm32"
      {
        nativeBuildInputs = [ sdk-fork-continuation ];
        meta = {
          license = lib.licenses.mit;
          description = "Explicit large-memory wasm32 fork correctness probe; not a default build";
        };
        passthru.checks.runtime = vm-test.rawInitramfsTest {
          name = "fork-high-layout-wasm32";
          init = "${probe}/probe.wasm";
          cpus = 2;
        };
      }
      ''
        mkdir $out
        # This pinned LLD defaults to stack-first: global-base alone leaves
        # the stack below 8 MiB. Only this explicit test uses data-first.
        wasm-linux-fork-cc -O2 -Wall -Wextra -Werror -Wl,--no-stack-first -Wl,--global-base=2147483648 ${./high32.c} -o linked.wasm
        wasm-linux-fork-finalize linked.wasm $out/probe.wasm
        cp ${./high32.c} ${./high32.nix} $out/
        ln -s ${sdk-fork-continuation.buildMaterials} $out/sdk-build-materials
      '';
in
probe
