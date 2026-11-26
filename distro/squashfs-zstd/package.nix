# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  llvm-toolchain,
  sysroot,
  vm-test,
  compression ? "zstd",
  xattrs ? false,
}:
assert builtins.elem compression [
  "zstd"
  "xz"
];
let
  xattrSuffix = if xattrs then "-xattrs" else "";
  flags = lib.escapeShellArgs (
    [
      "--target=${platform.targetTriple}"
      "--sysroot=${sysroot}"
    ]
    ++ platform.compilerFlags
    ++ map (flag: "-Wl,${flag}") platform.linkerFlags
  );
  image =
    pkgs.runCommand "squashfs-${compression}${xattrSuffix}.squashfs"
      {
        nativeBuildInputs = [
          pkgs.python3
          pkgs.squashfsTools
        ];
      }
      ''
        python3 ${./fixture.py} make root ${lib.optionalString xattrs "xattrs"}
        env -u SOURCE_DATE_EPOCH mksquashfs root "$out" -noappend -comp ${compression} -b 262144 -no-fragments \
          -all-root -all-time 0 -mkfs-time 0 ${if xattrs then "-xattrs" else "-no-xattrs"} \
          -no-exports -processors 1 -no-progress
        unsquashfs -s "$out" > superblock.txt
        unsquashfs -no-progress -d extracted "$out"
        python3 ${./fixture.py} check "$out" superblock.txt extracted ${compression} ${lib.optionalString xattrs "xattrs"}
      '';
  program =
    pkgs.runCommand "squashfs-${compression}${xattrSuffix}-${platform.wasmArch}"
      {
        nativeBuildInputs = [
          llvm-toolchain
          pkgs.wabt
        ];
        passthru.checks.runtime = vm-test.rawInitramfsTest {
          name = "squashfs-${compression}${xattrSuffix}-${platform.wasmArch}";
          init = "${program}/squashfs-${compression}${xattrSuffix}.wasm";
          disks = [ image ];
          readOnlyDisks = true;
          recordRuntimeLog = true;
        };
      }
      ''
        mkdir $out
        clang ${flags} -O2 -Wall -Wextra -Werror ${
          lib.optionalString (compression == "xz") "-DSQUASHFS_XZ"
        } \
          ${lib.optionalString xattrs "-DSQUASHFS_XATTRS"} \
          ${./runtime.c} -o $out/squashfs-${compression}${xattrSuffix}.wasm
        chmod 0755 $out/squashfs-${compression}${xattrSuffix}.wasm
        wasm-validate --enable-memory64 --enable-threads --enable-exceptions $out/squashfs-${compression}${xattrSuffix}.wasm
      '';
in
program
