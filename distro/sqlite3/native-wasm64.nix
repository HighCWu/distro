# SPDX-License-Identifier: MIT
{
  pkgs,
  sqlite3,
  sdk-wasm64,
  platform-wasm64,
}:
pkgs.runCommand "sqlite3-wasm64-${sqlite3.version}"
  {
    pname = "sqlite3";
    inherit (sqlite3) version src;
    meta.license = pkgs.lib.licenses.publicDomain;
    passthru.apk.license = "blessing AND MIT AND Apache-2.0 WITH LLVM-exception";
    nativeBuildInputs = [ pkgs.nodejs ];
    allowedReferences = [ ];
  }
  ''
    mkdir -p $out/bin $out/share/licenses/sqlite3
    ${sdk-wasm64}/bin/wasm-linux-cc -O2 -pthread \
      -DSQLITE_THREADSAFE=1 -DSQLITE_OMIT_LOAD_EXTENSION=1 \
      -DSQLITE_OMIT_WAL=1 -DSQLITE_MAX_MMAP_SIZE=0 \
      -I${sqlite3.src} ${sqlite3.src}/sqlite3.c ${sqlite3.src}/shell.c \
      -lm -o $out/bin/sqlite3
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      $out/bin/sqlite3 64 ${toString platform-wasm64.maximumMemoryBytes}
    # Preserve the upstream public-domain declaration with its original header.
    cp ${sqlite3.src}/sqlite3.h $out/share/licenses/sqlite3/sqlite3.h
    cp ${sdk-wasm64}/share/linux-wasm-sdk/licenses/musl/COPYRIGHT \
      $out/share/licenses/sqlite3/musl-COPYRIGHT
    cp ${sdk-wasm64}/share/linux-wasm-sdk/licenses/llvm-runtimes/compiler-rt-LICENSE.TXT \
      $out/share/licenses/sqlite3/compiler-rt-LICENSE.TXT
  ''
