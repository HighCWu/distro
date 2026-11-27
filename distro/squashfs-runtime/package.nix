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
  squashfsDisk =
    pkgs.runCommand "squashfs-runtime-zstd-disk"
      {
        nativeBuildInputs = [
          pkgs.squashfsTools
          pkgs.python3
        ];
      }
      ''
        mkdir -p root/nested/dir
        printf 'squashfs-small-v1' > root/small.txt
        printf 'squashfs-nested-v1' > root/nested/dir/info.txt
        ln -s dir/info.txt root/nested/link.txt
        python3 -c '
        data = bytes(((i * 137 + 41) & 0xff) for i in range(98304))
        open("root/large.bin", "wb").write(data)
        '
        mksquashfs root "$out" -comp zstd -noappend -all-root
      '';
in
stdenv.mkDerivation (finalAttrs: {
  pname = "squashfs-runtime";
  version = "1";
  dontUnpack = true;
  meta = {
    description = "Linux/Wasm SquashFS zstd mount, statfs, symlink, large read and EROFS runtime check";
    license = lib.licenses.mit;
  };

  nativeBuildInputs = [ pkgs.nodejs ];

  buildPhase = ''
    runHook preBuild
    $CC -O2 -Wall -Wextra -Werror ${./runtime.c} -o squashfs-runtime
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      squashfs-runtime ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 squashfs-runtime $out/bin/squashfs-runtime
    notices=$out/share/licenses/squashfs-runtime
    install -Dm644 ${../sdk/LICENSE.MIT} "$notices/LICENSE.MIT"
    install -Dm644 ${musl.src}/COPYRIGHT "$notices/musl-COPYRIGHT"
    install -Dm644 ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT \
      "$notices/compiler-rt-LICENSE.TXT"
    runHook postInstall
  '';

  passthru.checks = {
    runtime = vm-test.rawInitramfsTest {
      name = "squashfs-runtime-${platform.wasmArch}";
      init = ./runtime-test.sh;
      cpus = 1;
      contents = [
        busybox
        finalAttrs.finalPackage
      ];
      disks = [ squashfsDisk ];
    };
  }
  // extraChecks;
})
