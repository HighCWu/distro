# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  sysroot,
  llvm-toolchain,
  sdk-fork-continuation,
  kernel,
  image,
}:
let
  flags = lib.escapeShellArgs (
    [
      "--target=${platform.targetTriple}"
      "--sysroot=${sysroot}"
    ]
    ++ platform.compilerFlags
    ++ map (flag: "-Wl,${flag}") platform.linkerFlags
  );
  native = pkgs.runCommand "native-fork-latency" { nativeBuildInputs = [ pkgs.stdenv.cc ]; } ''
    mkdir $out
    cc --version > $out/compiler.txt
    cc -O2 -Wall -Wextra -Werror ${./latency-exec.c} -o $out/helper
    for mode in exit exec; do
      flag=0; if [ "$mode" = exec ]; then flag=1; fi
      for mib in 1 16 64; do
        cc -O2 -pthread -Wall -Wextra -Werror -DLATENCY_EXEC=$flag -DLATENCY_MIB=$mib \
          ${./latency.c} -o $out/$mode-$mib
      done
    done
  '';
  wasm =
    pkgs.runCommand "wasm-fork-latency-${platform.wasmArch}"
      {
        nativeBuildInputs = [
          llvm-toolchain
          sdk-fork-continuation
        ];
      }
      ''
        mkdir $out
        clang --version > $out/compiler.txt
        clang ${flags} -O2 -Wall -Wextra -Werror ${./latency-exec.c} -o $out/helper.wasm
        for mode in exit exec; do
          flag=0; if [ "$mode" = exec ]; then flag=1; fi
          for mib in 1 16 64; do
            wasm-linux-fork-cc -O2 -pthread -Wall -Wextra -Werror -DLATENCY_EXEC=$flag \
              -DLATENCY_MIB=$mib ${./latency.c} -o linked.wasm
            wasm-linux-fork-finalize linked.wasm $out/$mode-$mib.wasm
          done
        done
        chmod 0755 $out/*.wasm
      '';
  cases =
    lib.concatMap
      (
        exec:
        map
          (mib: {
            id = "${if exec == 1 then "exec" else "exit"}-${toString mib}";
            inherit exec;
            payloadBytes = mib * 1048576;
          })
          [
            1
            16
            64
          ]
      )
      [
        0
        1
      ];
  manifest = pkgs.writeText "native-fork-latency.json" (
    builtins.toJSON {
      schemaVersion = 1;
      inherit (platform) addressBits;
      samples = 30;
      warmups = 1;
      cpus = 2;
      inherit cases;
    }
  );
in
pkgs.runCommand "native-fork-latency-assets-${platform.wasmArch}" { } ''
  mkdir $out
  ln -s ${native} $out/native
  ln -s ${wasm} $out/wasm
  ln -s ${kernel} $out/kernel
  cp ${manifest} $out/manifest.json
  cp ${./latency.c} $out/latency.c
  cp ${./latency-exec.c} $out/latency-exec.c
  cp ${./latency-contract.js} $out/latency-contract.js
  cp ${./latency-boot.mjs} $out/latency-boot.mjs
  cp ${./latency-run.mjs} $out/latency-run.mjs
  cp ${../../packages/browser-tests/runtime-smoke.js} $out/runtime-smoke.js
  cp ${../vm-test/protocol.js} $out/protocol.js
  ${lib.concatMapStringsSep "\n" (c: ''
    ln -s ${
      image.mkInitramfs {
        name = "latency-${platform.wasmArch}-${c.id}";
        init = "${wasm}/${c.id}.wasm";
        files."/latency-helper" = "${wasm}/helper.wasm";
      }
    } $out/${c.id}.cpio
  '') cases}
''
