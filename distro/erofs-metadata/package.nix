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
          pkgs.erofs-utils
          pkgs.python3
        ];
      }
      ''
        ${
          if tolerance == 0 then
            ''
              python3 ${./shared-image.py} "$out"
            ''
          else
            ''
              python3 ${./make-fixture.py} --tar root.tar
              mkfs.erofs --all-root -T 0 -U 00000000-0000-0000-0000-000000000000 \
                --tar=f -x${toString tolerance} "$out" < root.tar
            ''
        }
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
          files = {
            "/inline.erofs" = image 99;
            "/shared.erofs" = image 0;
            "/invalid.erofs" = pkgs.writeText "invalid-erofs" "not an EROFS image\n";
          };
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
