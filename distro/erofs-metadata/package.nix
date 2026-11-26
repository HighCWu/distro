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
  compressedImage =
    pkgs.runCommand "erofs-compressed-lz4.erofs"
      {
        nativeBuildInputs = [
          pkgs.erofs-utils
          pkgs.python3
        ];
      }
      ''
        python3 ${./compressed-fixture.py} make root
        mkfs.erofs --all-root -T 0 -U 00000000-0000-0000-0000-000000000000 \
          -zlz4 --max-extent-bytes=262144 "$out" root
        dump.erofs --path=/payload -e "$out" | tee extents.txt
        fsck.erofs --extract=extracted "$out"
        python3 ${./compressed-fixture.py} check extents.txt extracted
      '';
  compressedProgram =
    pkgs.runCommand "erofs-compressed-${platform.wasmArch}"
      {
        nativeBuildInputs = [
          llvm-toolchain
          pkgs.wabt
        ];
      }
      ''
        mkdir $out
        clang ${flags} -O2 -Wall -Wextra -Werror ${./compressed-runtime.c} -o $out/erofs-compressed.wasm
        chmod 0755 $out/erofs-compressed.wasm
        wasm-validate --enable-memory64 --enable-threads --enable-exceptions $out/erofs-compressed.wasm
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
        passthru.checks.compressed = vm-test.rawInitramfsTest {
          name = "erofs-compressed-${platform.wasmArch}";
          init = "${compressedProgram}/erofs-compressed.wasm";
          disks = [ compressedImage ];
          files."/compressed.erofs" = compressedImage;
          readOnlyDisks = true;
          recordRuntimeLog = true;
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
