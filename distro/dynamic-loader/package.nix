# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  sdk-dynamic-loader,
  llvm-toolchain,
  musl,
  llvm-runtimes,
  vm-test,
  sharedCompiler ? null,
  extraChecks ? { },
}:
let
  sideCC =
    if sharedCompiler == null then
      "wasm-linux-dlopen-cc"
    else
      lib.escapeShellArgs (
        [
          "${sharedCompiler}/bin/clang"
          "--target=${platform.targetTriple}"
          "--sysroot=${sdk-dynamic-loader.sysroot}"
        ]
        ++ platform.compilerFlags
      );
  linkShared =
    {
      name,
      output,
      inputs,
      runpath ? null,
      extraFlags ? [ ],
    }:
    let
      flags = [
        "--shared-memory"
        "--import-memory"
        "--import-table"
        "--max-memory=${toString platform.maximumMemoryBytes}"
        "--export-all"
        "--export=__wasm_call_ctors"
        "--export=__tls_base"
        "--soname=${name}"
      ]
      ++ lib.optional (runpath != null) "--rpath=${runpath}"
      ++ extraFlags;
    in
    # Both the SDK and the standalone compiler dispatch shared links through
    # Clang. Their Linux driver selects the shared object's runtime inputs.
    sideCC
    + " -shared "
    + lib.escapeShellArgs (
      (map (flag: "-Wl,${flag}") flags)
      ++ inputs
      ++ [
        "-o"
        output
      ]
    );
  compilerCommands = pkgs.writeText "dynamic-loader-compiler-commands.json" (
    builtins.toJSON {
      executable = "wasm-linux-dlopen-cc";
      shared = sideCC;
      sharedMode = if sharedCompiler == null then "dynamic-sdk" else "standalone-linux-driver";
    }
  );
in
pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
  pname = if sharedCompiler == null then "dynamic-loader" else "dynamic-loader-driver";
  version = "1";
  outputs = [
    "out"
    "buildMaterials"
  ];
  dontUnpack = true;
  dontFixup = true;
  nativeBuildInputs = [
    sdk-dynamic-loader
    llvm-toolchain
    pkgs.nodejs
    pkgs.python3
  ];
  buildPhase = ''
    runHook preBuild
    python3 ${./generate-unused-main-exports.py} 4096 unused-main-exports.c
    wasm-linux-dlopen-cc -O2 -Wall -Wextra -Werror ${./runtime.c} -o dynamic-loader.wasm
    wasm-linux-dlopen-cc -O2 -Wall -Wextra -Werror ${./scope-memory-runtime.c} unused-main-exports.c -o scope-memory-runtime.wasm
    ${sideCC} -O2 -Wall -Wextra -Werror -fPIC -c ${./scope-memory-library.c} -o scope-memory-library.o
    ${linkShared {
      name = "scope-memory-library.so";
      output = "scope-memory-library.so";
      inputs = [ "scope-memory-library.o" ];
    }}
    wasm-linux-dlopen-cc -O2 -Wall -Wextra -Werror ${./capacity-consumer.c} -o capacity-consumer.wasm
    ${sideCC} -O2 -Wall -Wextra -Werror -fPIC -c ${./capacity-leaf.c} -o capacity-leaf.o
    ${linkShared {
      name = "capacity-leaf.so";
      output = "capacity-leaf.so";
      inputs = [ "capacity-leaf.o" ];
    }}
    wasm-linux-dlopen-cc -O2 -Wall -Wextra -Werror ${./spawn.c} -o spawn.wasm
    wasm-linux-dlopen-cc -O2 -Wall -Wextra -Werror ${./poll-runtime.c} -o poll-runtime.wasm
    wasm-linux-dlopen-cc -O2 -Wall -Wextra -Werror -pthread ${./thread-runtime.c} -o thread-runtime.wasm
    ${sideCC} -O2 -Wall -Wextra -Werror -fPIC -c ${./poll-library.c} -o poll-library.o
    ${linkShared {
      name = "poll-library.so";
      output = "poll-library.so";
      inputs = [ "poll-library.o" ];
    }}
    ${sideCC} -O2 -fPIC -c ${./library-a.c} -o a.o
    ${sideCC} -r a.o -o a-partial.o
    ${sideCC} -O2 -fPIC -c ${./library-b.c} -o b.o
    ${sideCC} -O2 -fPIC -c ${./path-library.c} -o path-library.o
    ${linkShared {
      name = "path-library.so";
      output = "path-library.so";
      inputs = [ "path-library.o" ];
    }}
    ${linkShared {
      name = "libplugin-a.so";
      output = "libplugin-a.so";
      inputs = [ "a-partial.o" ];
    }}
    ${linkShared {
      name = "libplugin-b.so";
      output = "libplugin-b.so";
      inputs = [
        "b.o"
        "libplugin-a.so"
      ];
      runpath = "$ORIGIN/deps";
    }}
    ${sideCC} -O2 -mtail-call -Wall -Wextra -Werror -fPIC -DTAIL_STEP=1 -c ${./tail-library.c} -o tail-one.o
    ${sideCC} -O2 -mtail-call -Wall -Wextra -Werror -fPIC -DTAIL_STEP=3 -c ${./tail-library.c} -o tail-three.o
    ${linkShared {
      name = "libtail-step-one.so";
      output = "libtail-step-one.so";
      inputs = [ "tail-one.o" ];
    }}
    ${linkShared {
      name = "libtail-step-three.so";
      output = "libtail-step-three.so";
      inputs = [ "tail-three.o" ];
    }}
    # Append the opt-in ABI marker as a normal Wasm custom section. Its payload
    # is the 20-byte section name followed by version byte 1.
    printf '\000\026\024linux.dylink.tail.v1\001' >> libtail-step-one.so
    printf '\000\026\024linux.dylink.tail.v1\001' >> libtail-step-three.so
    ${sideCC} -O2 -msimd128 -fPIC -c ${./cycle-a.c} -o cycle-a.o
    ${sideCC} -O2 -msimd128 -fPIC -c ${./cycle-b.c} -o cycle-b.o
    ${sideCC} -O2 -fPIC -DDYNAMIC_MAIN_POLL_CONSUMER=1 -c ${./reentrant-root.c} -o reentrant-root.o
    ${sideCC} -O2 -fPIC -c ${./reentrant-leaf.c} -o reentrant-leaf.o
    ${sideCC} -O2 -fPIC -c ${./reentrant-reject.c} -o reentrant-reject.o
    ${sideCC} -O2 -fPIC -c ${./next-front.c} -o next-front.o
    ${sideCC} -O2 -fPIC -c ${./next-middle.c} -o next-middle.o
    ${sideCC} -O2 -fPIC -c ${./next-leaf.c} -o next-leaf.o
    ${sideCC} -O2 -fPIC -c ${./reexport-provider.c} -o reexport-provider.o
    ${sideCC} -O2 -fPIC -c ${./reexport-forwarder.c} -o reexport-forwarder.o
    ${sideCC} -O2 -fPIC -c ${./reexport-consumer.c} -o reexport-consumer.o
    ${sideCC} -O2 -fPIC -c ${./lazy-consumer.c} -o lazy-consumer.o
    ${sideCC} -O2 -fPIC -c ${./lazy-local.c} -o lazy-local.o
    ${sideCC} -O2 -fPIC -c ${./lazy-provider.c} -o lazy-provider.o
    ${sideCC} -O2 -fPIC -c ${./lazy-bad.c} -o lazy-bad.o
    ${linkShared {
      name = "next-leaf.so";
      output = "next-leaf.so";
      inputs = [ "next-leaf.o" ];
    }}
    ${linkShared {
      name = "next-middle.so";
      output = "next-middle.so";
      inputs = [
        "next-middle.o"
        "next-leaf.so"
      ];
      runpath = "$ORIGIN";
    }}
    ${linkShared {
      name = "next-front.so";
      output = "next-front.so";
      inputs = [
        "next-front.o"
        "next-middle.so"
      ];
      runpath = "$ORIGIN/next";
    }}
    ${linkShared {
      name = "libreexport-provider.so";
      output = "libreexport-provider.so";
      inputs = [ "reexport-provider.o" ];
    }}
    ${linkShared {
      name = "libreexport-forwarder.so";
      output = "libreexport-forwarder.so";
      inputs = [
        "reexport-forwarder.o"
        "libreexport-provider.so"
      ];
      runpath = "$ORIGIN";
      extraFlags = [ "--export=reexport_target" ];
    }}
    ${linkShared {
      name = "libreexport-consumer.so";
      output = "libreexport-consumer.so";
      inputs = [
        "reexport-consumer.o"
        "libreexport-forwarder.so"
      ];
      runpath = "$ORIGIN";
    }}
    # Inspect the actual linked bytes: dlsym could find the symbol through
    # dependency scope even if this DSO forgot its own import-function export.
    node ${./reexport-check.js} ${../../packages/kernel/src/wasm_binary.ts} libreexport-forwarder.so libreexport-provider.so libreexport-consumer.so
    ${linkShared {
      name = "liblazy-consumer.so";
      output = "liblazy-consumer.so";
      inputs = [ "lazy-consumer.o" ];
    }}
    ${linkShared {
      name = "liblazy-local.so";
      output = "liblazy-local.so";
      inputs = [ "lazy-local.o" ];
    }}
    ${linkShared {
      name = "liblazy-provider.so";
      output = "liblazy-provider.so";
      inputs = [ "lazy-provider.o" ];
    }}
    ${linkShared {
      name = "liblazy-bad.so";
      output = "liblazy-bad.so";
      inputs = [ "lazy-bad.o" ];
    }}
    ${linkShared {
      name = "reentrant-root.so";
      output = "reentrant-root.so";
      inputs = [ "reentrant-root.o" ];
    }}
    ${linkShared {
      name = "reentrant-leaf.so";
      output = "reentrant-leaf.so";
      inputs = [ "reentrant-leaf.o" ];
    }}
    ${linkShared {
      name = "reentrant-reject.so";
      output = "reentrant-reject.so";
      inputs = [ "reentrant-reject.o" ];
    }}
    # Bootstrap A with its final basename to express both NEEDED edges.
    # Only the final A and B are installed; neither embeds the other's code.
    mkdir bootstrap
    ${linkShared {
      name = "cycle-a.so";
      output = "bootstrap/cycle-a.so";
      inputs = [ "cycle-a.o" ];
    }}
    ${linkShared {
      name = "cycle-b.so";
      output = "cycle-b.so";
      inputs = [
        "cycle-b.o"
        "bootstrap/cycle-a.so"
      ];
    }}
    ${linkShared {
      name = "cycle-a.so";
      output = "cycle-a.so";
      inputs = [
        "cycle-a.o"
        "cycle-b.so"
      ];
    }}
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 dynamic-loader.wasm $out/dynamic-loader.wasm
    install -Dm755 scope-memory-runtime.wasm $out/scope-memory-runtime.wasm
    install -Dm644 scope-memory-library.so $out/lib/scope-memory-library.so
    install -Dm755 capacity-consumer.wasm $out/capacity-consumer.wasm
    install -Dm644 capacity-leaf.so $out/lib/capacity-leaf.so
    install -Dm755 spawn.wasm $out/spawn.wasm
    install -Dm755 poll-runtime.wasm $out/poll-runtime.wasm
    install -Dm755 thread-runtime.wasm $out/thread-runtime.wasm
    install -Dm644 poll-library.so $out/lib/poll-library.so
    install -Dm644 libplugin-a.so $out/lib/libplugin-a.so
    install -Dm644 libplugin-b.so $out/lib/libplugin-b.so
    install -Dm644 libtail-step-one.so $out/lib/libtail-step-one.so
    install -Dm644 libtail-step-three.so $out/lib/libtail-step-three.so
    install -Dm644 path-library.so $out/lib/path-library.so
    install -Dm644 cycle-a.so $out/lib/cycle-a.so
    install -Dm644 cycle-b.so $out/lib/cycle-b.so
    install -Dm644 reentrant-root.so $out/lib/reentrant-root.so
    install -Dm644 reentrant-leaf.so $out/lib/reentrant-leaf.so
    install -Dm644 reentrant-reject.so $out/lib/reentrant-reject.so
    install -Dm644 next-front.so $out/lib/next-front.so
    install -Dm644 next-middle.so $out/lib/next/next-middle.so
    install -Dm644 next-leaf.so $out/lib/next/next-leaf.so
    install -Dm644 libreexport-provider.so $out/lib/libreexport-provider.so
    install -Dm644 libreexport-forwarder.so $out/lib/libreexport-forwarder.so
    install -Dm644 libreexport-consumer.so $out/lib/libreexport-consumer.so
    install -Dm644 liblazy-consumer.so $out/lib/liblazy-consumer.so
    install -Dm644 liblazy-local.so $out/lib/liblazy-local.so
    install -Dm644 liblazy-provider.so $out/lib/liblazy-provider.so
    install -Dm644 liblazy-bad.so $out/lib/liblazy-bad.so
    install -Dm644 ${../sdk/LICENSE.MIT} $out/share/licenses/dynamic-loader/LICENSE.MIT
    cp ${musl.src}/COPYRIGHT $out/share/licenses/dynamic-loader/musl-COPYRIGHT
    cp ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT $out/share/licenses/dynamic-loader/compiler-rt-LICENSE.TXT
    mkdir -p $buildMaterials/share/dynamic-loader-materials
    cp ${./capacity-consumer.c} ${./capacity-leaf.c} ${./scope-memory-runtime.c} ${./scope-memory-library.c} ${./generate-unused-main-exports.py} unused-main-exports.c $buildMaterials/share/dynamic-loader-materials/
    cp ${./runtime.c} ${./library-a.c} ${./library-b.c} ${./cycle-a.c} ${./cycle-b.c} ${./package.nix} $buildMaterials/share/dynamic-loader-materials/
    cp ${./tail-library.c} $buildMaterials/share/dynamic-loader-materials/
    cp ${./spawn.c} $buildMaterials/share/dynamic-loader-materials/
    cp ${./poll-runtime.c} ${./poll-library.c} $buildMaterials/share/dynamic-loader-materials/
    cp ${./thread-runtime.c} $buildMaterials/share/dynamic-loader-materials/
    cp ${./path-library.c} $buildMaterials/share/dynamic-loader-materials/
    cp ${./reentrant-root.c} ${./reentrant-leaf.c} ${./reentrant-reject.c} $buildMaterials/share/dynamic-loader-materials/
    cp ${./next-front.c} ${./next-middle.c} ${./next-leaf.c} $buildMaterials/share/dynamic-loader-materials/
    cp ${./reexport-provider.c} ${./reexport-forwarder.c} ${./reexport-consumer.c} $buildMaterials/share/dynamic-loader-materials/
    cp ${./lazy-consumer.c} ${./lazy-local.c} ${./lazy-provider.c} ${./lazy-bad.c} $buildMaterials/share/dynamic-loader-materials/
    cp ${./reexport-check.js} $buildMaterials/share/dynamic-loader-materials/
    cp ${compilerCommands} $buildMaterials/share/dynamic-loader-materials/compiler-commands.json
    ln -s ${sdk-dynamic-loader.buildMaterials} $buildMaterials/share/dynamic-loader-materials/sdk
    ${lib.optionalString (sharedCompiler != null) ''
      cp ${./linux-shared.patch} $buildMaterials/share/dynamic-loader-materials/
      cp ${sharedCompiler.src}/llvm/LICENSE.TXT $out/share/licenses/dynamic-loader/LLVM-LICENSE.TXT
    ''}
    runHook postInstall
  '';
  meta.license = lib.licenses.mit;
  passthru.checks = {
    scope-memory-runtime = vm-test.rawInitramfsTest {
      name = "dynamic-scope-memory-${platform.wasmArch}";
      init = "${finalAttrs.finalPackage}/scope-memory-runtime.wasm";
      files."/scope-memory-library.so" = "${finalAttrs.finalPackage}/lib/scope-memory-library.so";
      nodeArguments = [ "--max-old-space-size=192" ];
    };
    capacity-runtime = vm-test.rawInitramfsTest {
      name = "dynamic-capacity-${platform.wasmArch}";
      init = "${finalAttrs.finalPackage}/capacity-consumer.wasm";
      files."/capacity-leaf.so" = "${finalAttrs.finalPackage}/lib/capacity-leaf.so";
    };
    thread-runtime = vm-test.rawInitramfsTest {
      name = "dynamic-pthread-${platform.wasmArch}";
      init = "${finalAttrs.finalPackage}/thread-runtime.wasm";
    };
    poll-runtime = vm-test.rawInitramfsTest {
      name = "dynamic-side-poll-${platform.wasmArch}";
      init = "${finalAttrs.finalPackage}/poll-runtime.wasm";
      files."/plugins/poll-library.so" = "${finalAttrs.finalPackage}/lib/poll-library.so";
    };
    spawn-runtime = vm-test.rawInitramfsTest {
      name = "dynamic-spawn-${platform.wasmArch}";
      init = "${finalAttrs.finalPackage}/spawn.wasm";
    };
    runtime = vm-test.rawInitramfsTest {
      name = "${finalAttrs.pname}-${platform.wasmArch}";
      init = "${finalAttrs.finalPackage}/dynamic-loader.wasm";
      files = {
        "/plugins/libplugin-b.so" = "${finalAttrs.finalPackage}/lib/libplugin-b.so";
        "/plugins/libtail-step-one.so" = "${finalAttrs.finalPackage}/lib/libtail-step-one.so";
        "/plugins/libtail-step-three.so" = "${finalAttrs.finalPackage}/lib/libtail-step-three.so";
        "/plugins/path-library.so" = "${finalAttrs.finalPackage}/lib/path-library.so";
        "/plugins/deps/libplugin-a.so" = "${finalAttrs.finalPackage}/lib/libplugin-a.so";
        "/plugins/cycle-a.so" = "${finalAttrs.finalPackage}/lib/cycle-a.so";
        "/plugins/cycle-b.so" = "${finalAttrs.finalPackage}/lib/cycle-b.so";
        "/plugins/reentrant-root.so" = "${finalAttrs.finalPackage}/lib/reentrant-root.so";
        "/plugins/reentrant-leaf.so" = "${finalAttrs.finalPackage}/lib/reentrant-leaf.so";
        "/plugins/reentrant-reject.so" = "${finalAttrs.finalPackage}/lib/reentrant-reject.so";
        "/plugins/next-front.so" = "${finalAttrs.finalPackage}/lib/next-front.so";
        "/plugins/next/next-middle.so" = "${finalAttrs.finalPackage}/lib/next/next-middle.so";
        "/plugins/next/next-leaf.so" = "${finalAttrs.finalPackage}/lib/next/next-leaf.so";
        "/plugins/libreexport-provider.so" = "${finalAttrs.finalPackage}/lib/libreexport-provider.so";
        "/plugins/libreexport-forwarder.so" = "${finalAttrs.finalPackage}/lib/libreexport-forwarder.so";
        "/plugins/libreexport-consumer.so" = "${finalAttrs.finalPackage}/lib/libreexport-consumer.so";
        "/plugins/liblazy-consumer.so" = "${finalAttrs.finalPackage}/lib/liblazy-consumer.so";
        "/plugins/liblazy-local.so" = "${finalAttrs.finalPackage}/lib/liblazy-local.so";
        "/plugins/liblazy-provider.so" = "${finalAttrs.finalPackage}/lib/liblazy-provider.so";
        "/plugins/liblazy-bad.so" = "${finalAttrs.finalPackage}/lib/liblazy-bad.so";
      };
    };
  }
  // extraChecks;
})
