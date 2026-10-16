# SPDX-License-Identifier: MIT
{
  pkgs,
  sqlite3,
  sdk-wasm64,
  platform-wasm64,
  vm-test,
}:
let
  pkgConfig = pkgs.replaceVars ./sqlite3.pc.in { inherit (sqlite3) version; };
  package =
    pkgs.runCommand "sqlite3-wasm64-${sqlite3.version}"
      {
        pname = "sqlite3";
        inherit (sqlite3) version src;
        outputs = [
          "out"
          "dev"
        ];
        meta = {
          license = pkgs.lib.licenses.publicDomain;
          outputsToInstall = [ "out" ];
        };
        passthru.apk.license = "blessing AND MIT AND Apache-2.0 WITH LLVM-exception";
        nativeBuildInputs = [ pkgs.nodejs ];
        allowedReferences = [ ];
      }
      ''
        mkdir -p $out/bin $out/share/licenses/sqlite3 $dev/include $dev/lib/pkgconfig
        ${sdk-wasm64}/bin/wasm-linux-cc -O2 -pthread \
          -DSQLITE_THREADSAFE=1 -DSQLITE_OMIT_LOAD_EXTENSION=1 \
          -DSQLITE_OMIT_WAL=1 -DSQLITE_MAX_MMAP_SIZE=0 \
          -I${sqlite3.src} -c ${sqlite3.src}/sqlite3.c -o sqlite3.o
        ${sdk-wasm64}/bin/llvm-ar rcs $dev/lib/libsqlite3.a sqlite3.o
        cp ${sqlite3.src}/sqlite3.h ${sqlite3.src}/sqlite3ext.h $dev/include/
        cp ${pkgConfig} $dev/lib/pkgconfig/sqlite3.pc
        ${sdk-wasm64}/bin/wasm-linux-cc -O2 -pthread \
          -DSQLITE_THREADSAFE=1 -DSQLITE_OMIT_LOAD_EXTENSION=1 \
          -DSQLITE_OMIT_WAL=1 -DSQLITE_MAX_MMAP_SIZE=0 \
          -I$dev/include ${sqlite3.src}/shell.c $dev/lib/libsqlite3.a \
          -lm -o $out/bin/sqlite3
        node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
          $out/bin/sqlite3 64 ${toString platform-wasm64.maximumMemoryBytes}
        # Preserve the upstream public-domain declaration with its original header.
        cp ${sqlite3.src}/sqlite3.h $out/share/licenses/sqlite3/sqlite3.h
        cp ${sdk-wasm64}/share/linux-wasm-sdk/licenses/musl/COPYRIGHT \
          $out/share/licenses/sqlite3/musl-COPYRIGHT
        cp ${sdk-wasm64}/share/linux-wasm-sdk/licenses/llvm-runtimes/compiler-rt-LICENSE.TXT \
          $out/share/licenses/sqlite3/compiler-rt-LICENSE.TXT
        mkdir -p $dev/share/licenses
        cp -r $out/share/licenses/sqlite3 $dev/share/licenses/
      '';
  consumer =
    pkgs.runCommand "sqlite3-wasm64-installed-consumer"
      {
        nativeBuildInputs = [ pkgs.nodejs ];
      }
      ''
        mkdir -p $out relocated
        cp -r ${package.dev}/. relocated/
        export WASM_PKG_CONFIG_PATH="$PWD/relocated/lib/pkgconfig"
        export WASM_PKG_CONFIG_SYSROOT_DIR=/
        sqlite_cflags_text=$(${sdk-wasm64}/bin/wasm-linux-pkg-config --cflags sqlite3)
        sqlite_libs_text=$(${sdk-wasm64}/bin/wasm-linux-pkg-config --libs sqlite3)
        read -ra sqlite_cflags <<< "$sqlite_cflags_text"
        read -ra sqlite_libs <<< "$sqlite_libs_text"
        # Neither flags nor the consumer source may secretly rebuild the amalgamation.
        case "''${sqlite_cflags[*]} ''${sqlite_libs[*]}" in
          *${package.dev}*) echo 'SQLite metadata did not relocate' >&2; exit 1 ;;
        esac
        case "''${sqlite_cflags[*]} ''${sqlite_libs[*]}" in
          *"$PWD/relocated"*) ;;
          *) echo 'SQLite flags did not select the relocated installation' >&2; exit 1 ;;
        esac
        ${sdk-wasm64}/bin/wasm-linux-cc -O2 -pthread -Wall -Wextra -Werror \
          "''${sqlite_cflags[@]}" ${../sdk/sqlite-example.c} "''${sqlite_libs[@]}" \
          -o $out/sqlite-consumer.wasm
        node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
          $out/sqlite-consumer.wasm 64 ${toString platform-wasm64.maximumMemoryBytes}
      '';
in
package
// {
  checks.development = vm-test.rawInitramfsTest {
    name = "sqlite3-wasm64-installed-development";
    init = "${consumer}/sqlite-consumer.wasm";
  };
}
