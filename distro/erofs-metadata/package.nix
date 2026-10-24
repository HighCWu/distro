# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  llvm-toolchain,
  sysroot,
  vm-test,
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
  image =
    tolerance:
    pkgs.runCommand "erofs-metadata-${toString tolerance}.erofs"
      {
        nativeBuildInputs = [
          pkgs.attr
          pkgs.erofs-utils
          pkgs.python3
        ];
      }
      ''
          mkdir root
          install -m 0644 ${pkgs.writeText "metadata-file" "contents\n"} root/file
          ln -s file root/link
          setfattr -n user.binary -v 0x00010200ff7f80 root/file
          setfattr -n user.empty -v "" root/file
          setfattr -n user.directory -v dir root
        setfattr -n user.binary -v 0x00010200ff7f80 root
        setfattr -n user.empty -v "" root
          mkfs.erofs --all-root -T 0 -U 00000000-0000-0000-0000-000000000000 \
            -x${toString tolerance} "$out" root
          fsck.erofs "$out"
        python3 ${./check-image.py} "$out" ${if tolerance == 0 then "shared" else "inline"}
      '';
  program =
    pkgs.runCommand "erofs-metadata-${platform.wasmArch}"
      {
        nativeBuildInputs = [
          llvm-toolchain
          pkgs.wabt
        ];
        passthru.checks.runtime = vm-test.rawInitramfsTest {
          name = "erofs-metadata-${platform.wasmArch}";
          init = "${program}/erofs-metadata.wasm";
          disks = [
            (image 99)
            (image 0)
          ];
          readOnlyDisks = true;
        };
      }
      ''
        mkdir $out
        clang ${flags} -O2 -Wall -Wextra -Werror ${./runtime.c} -o $out/erofs-metadata.wasm
        chmod 0755 $out/erofs-metadata.wasm
        wasm-validate --enable-memory64 --enable-threads --enable-exceptions $out/erofs-metadata.wasm
      '';
in
program
