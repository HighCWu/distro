# SPDX-License-Identifier: MIT
{
  pkgs,
  platform,
  sdk,
  vm-test,
  busybox,
  extraChecks ? { },
}:
let
  program =
    pkgs.runCommand "symbol-versions-${platform.wasmArch}"
      {
        nativeBuildInputs = [ pkgs.nodejs ];
        passthru = {
          # Exercise the ordinary SDK; no separate compiler or libc override.
          inherit sdk;
          apk.license = "MIT AND Apache-2.0 WITH LLVM-exception";
          checks = {
            profile = sdk.checks.profile;
            cxx-runtime = sdk.checks.cxx-runtime;
            runtime = vm-test.installedTest {
              name = "symbol-versions-${platform.wasmArch}";
              init = ./runtime.sh;
              cpus = 2;
              contents = [
                busybox
                program
              ];
            };
          }
          // extraChecks;
        };
      }
      ''
        mkdir -p $out/bin $out/share/licenses/symbol-versions
        ${sdk}/bin/wasm-linux-cc -O2 -Wall -Wextra -Werror -c ${./provider.c} -o provider.o
        ${sdk}/bin/wasm-linux-cc -O2 -Wall -Wextra -Werror -c ${./runtime.c} -o runtime.o
        ${sdk}/bin/wasm-linux-cc -Wl,--fatal-warnings provider.o runtime.o -o $out/bin/symbol-versions
        node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
          $out/bin/symbol-versions ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
        cp ${../sdk/LICENSE.MIT} $out/share/licenses/symbol-versions/test-MIT
        # SDK joins expose notices through store symlinks. The installed Linux
        # image needs actual notice bytes, independent of the build host store.
        cp -rL ${sdk}/share/linux-wasm-sdk/licenses $out/share/licenses/symbol-versions/sdk
        (cd $out/share/licenses/symbol-versions/sdk && sha256sum --check SHA256SUMS)
      '';
in
program
