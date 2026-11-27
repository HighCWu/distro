# SPDX-License-Identifier: MIT
{
  pkgs,
  stdenv,
  lib,
  musl,
  llvm-runtimes,
  platform,
  busybox,
  vm-test,
  extraChecks ? { },
}:
let
  isofsDisk =
    pkgs.runCommand "isofs-runtime-rockridge-disk"
      {
        nativeBuildInputs = [
          pkgs.xorriso
          pkgs.python3
        ];
      }
      ''
        mkdir -p root/nested/dir
        printf 'isofs-small-v1' > root/small.txt
        printf 'isofs-nested-v1' > root/nested/dir/info.txt
        ln -s dir/info.txt root/nested/link.txt
        python3 -c '
        data = bytes(((i * 149 + 61) & 0xff) for i in range(98304))
        open("root/large.bin", "wb").write(data)
        '
        xorriso -as mkisofs -r -J -V WASMISO -o "$out" root
      '';
in
stdenv.mkDerivation (finalAttrs: {
  pname = "isofs-runtime";
  version = "1";
  dontUnpack = true;
  meta = {
    description = "Linux/Wasm ISO 9660 Rock Ridge mount, statfs, symlink, large read and EROFS runtime check";
    license = lib.licenses.mit;
  };

  nativeBuildInputs = [ pkgs.nodejs ];

  buildPhase = ''
    runHook preBuild
    $CC -O2 -Wall -Wextra -Werror ${./runtime.c} -o isofs-runtime
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      isofs-runtime ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 isofs-runtime $out/bin/isofs-runtime
    notices=$out/share/licenses/isofs-runtime
    install -Dm644 ${../sdk/LICENSE.MIT} "$notices/LICENSE.MIT"
    install -Dm644 ${musl.src}/COPYRIGHT "$notices/musl-COPYRIGHT"
    install -Dm644 ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT \
      "$notices/compiler-rt-LICENSE.TXT"
    runHook postInstall
  '';

  passthru.checks = {
    runtime = vm-test.rawInitramfsTest {
      name = "isofs-runtime-${platform.wasmArch}";
      init = ./runtime-test.sh;
      cpus = 1;
      contents = [
        busybox
        finalAttrs.finalPackage
      ];
      disks = [ isofsDisk ];
    };
  }
  // extraChecks;
})
