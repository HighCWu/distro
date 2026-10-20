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
  profile ? false,
}:
let
  flagsFor =
    root:
    lib.escapeShellArgs (
      [
        "--target=${platform.targetTriple}"
        "--sysroot=${root}"
      ]
      ++ platform.compilerFlags
      ++ map (flag: "-Wl,${flag}") platform.linkerFlags
    );
  programs =
    pkgs.runCommand "fork-benchmark-programs-${platform.wasmArch}"
      {
        nativeBuildInputs = [
          llvm-toolchain
          sdk-fork-continuation
        ];
      }
      ''
        mkdir $out
        clang --version > $out/compiler-version.txt
        clang ${flagsFor sysroot} -O2 -pthread -Wall -Wextra -Werror ${./benchmark.c} -o $out/default.wasm
        # Valid non-fork control: fork libc, but no continuation ABI object.
        clang ${flagsFor sdk-fork-continuation.sysroot} -O2 -pthread -Wall -Wextra -Werror ${./benchmark.c} -o $out/fork-libc-raw.wasm
        wasm-linux-fork-finalize $out/fork-libc-raw.wasm $out/fork-libc-asyncify.wasm
        # The actual SDK's untransformed ABI module is intentionally NOT booted.
        wasm-linux-fork-cc -O2 -pthread -Wall -Wextra -Werror ${./benchmark.c} -o $out/sdk-linked.wasm
        wasm-linux-fork-finalize $out/sdk-linked.wasm $out/sdk-asyncify.wasm
        for mib in 1 16 64; do
          wasm-linux-fork-cc -O2 -pthread -Wall -Wextra -Werror -DBENCH_FORK=1 \
            -DBENCH_PAYLOAD_MIB=$mib ${./benchmark.c} -o $out/fork-$mib-raw.wasm
          wasm-linux-fork-finalize $out/fork-$mib-raw.wasm $out/fork-$mib.wasm
        done
        chmod 0755 $out/*.wasm
      '';
  workCases =
    map
      (variant: {
        id = variant;
        kind = "work";
        inherit variant;
        payloadBytes = 0;
        binary = "${variant}.wasm";
      })
      [
        "default"
        "fork-libc-raw"
        "fork-libc-asyncify"
        "sdk-asyncify"
      ];
  forkCases =
    map
      (mib: {
        id = "fork-${toString mib}";
        kind = "fork";
        variant = "sdk-asyncify";
        payloadBytes = mib * 1024 * 1024;
        binary = "fork-${toString mib}.wasm";
      })
      [
        1
        16
        64
      ];
  cases = workCases ++ forkCases;
  manifest = pkgs.writeText "fork-benchmark.json" (
    builtins.toJSON (
      {
        schemaVersion = 1;
        inherit (platform) addressBits;
        samples = 5;
        warmups = 1;
        workIterations = 262144;
        syscallIterations = 4096;
        inherit cases;
        cpus = 2;
      }
      // lib.optionalAttrs profile {
        profile = true;
        profileVersion = 3;
      }
    )
  );
in
# Build immutable inputs only. Fresh measurement is a separate workflow step,
# never a cached Nix check result and never a default runtime profile.
pkgs.runCommand "fork-benchmark-assets-${platform.wasmArch}" { } ''
  mkdir $out
  ln -s ${programs} $out/binaries
  ln -s ${kernel} $out/kernel
  cp ${manifest} $out/manifest.json
  cp ${./benchmark.c} $out/benchmark.c
  cp ${./benchmark-contract.js} $out/benchmark-contract.js
  cp ${./benchmark-profile.js} $out/benchmark-profile.js
  cp ${./benchmark-profile-capture.js} $out/benchmark-profile-capture.js
  cp ${./benchmark-boot.mjs} $out/benchmark-boot.mjs
  cp ${./benchmark-run.mjs} $out/benchmark-run.mjs
  cp ${../../packages/browser-tests/runtime-smoke.js} $out/runtime-smoke.js
  cp ${../vm-test/protocol.js} $out/protocol.js
  ${lib.concatMapStringsSep "\n" (case: ''
    ln -s ${
      image.mkInitramfs {
        name = "fork-benchmark-${platform.wasmArch}-${case.id}";
        init = "${programs}/${case.binary}";
      }
    } $out/${case.id}.cpio
  '') cases}
''
