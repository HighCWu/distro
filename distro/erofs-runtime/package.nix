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
  erofsDisk =
    pkgs.runCommand "erofs-runtime-lz4-disk"
      {
        nativeBuildInputs = [
          pkgs.erofs-utils
          pkgs.python3
        ];
      }
      ''
        mkdir -p root/nested/dir
        printf 'erofs-small-v1' > root/small.txt
        printf 'erofs-nested-v1' > root/nested/dir/info.txt
        ln -s dir/info.txt root/nested/link.txt
        python3 -c '
        data = bytes(((i * 139 + 53) & 0xff) for i in range(98304))
        open("root/large.bin", "wb").write(data)
        '
        mkfs.erofs -zlz4 --all-root "$out" root
      '';
in
stdenv.mkDerivation (finalAttrs: {
  pname = "erofs-runtime";
  version = "1";
  dontUnpack = true;
  meta = {
    description = "Linux/Wasm EROFS lz4 mount, statfs, symlink, xattr, large read and EROFS runtime check";
    license = lib.licenses.mit;
  };

  nativeBuildInputs = [ pkgs.nodejs ];

  buildPhase = ''
    runHook preBuild
    $CC -O2 -Wall -Wextra -Werror ${./runtime.c} -o erofs-runtime
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      erofs-runtime ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 erofs-runtime $out/bin/erofs-runtime
    notices=$out/share/licenses/erofs-runtime
    install -Dm644 ${../sdk/LICENSE.MIT} "$notices/LICENSE.MIT"
    install -Dm644 ${musl.src}/COPYRIGHT "$notices/musl-COPYRIGHT"
    install -Dm644 ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT \
      "$notices/compiler-rt-LICENSE.TXT"
    runHook postInstall
  '';

  passthru.checks = {
    runtime = vm-test.rawInitramfsTest {
      name = "erofs-runtime-${platform.wasmArch}";
      init = ./runtime-test.sh;
      cpus = 1;
      contents = [
        busybox
        finalAttrs.finalPackage
      ];
      disks = [ erofsDisk ];
    };
  }
  // extraChecks;
})
