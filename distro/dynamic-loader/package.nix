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
      ++ lib.optional (runpath != null) "--rpath=${runpath}";
    in
    if sharedCompiler == null then
      "wasm-ld -m ${platform.wasmArch} --shared --no-entry --unresolved-symbols=import-dynamic "
      + lib.escapeShellArgs (
        flags
        ++ inputs
        ++ [
          "-o"
          output
        ]
      )
    else
      # Keep main-only execution objects/libc export archives out of DSOs.
      # This is the actual Linux driver; no -nostdlib or manual wasm-ld fallback.
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
  ];
  buildPhase = ''
    runHook preBuild
    wasm-linux-dlopen-cc -O2 -Wall -Wextra -Werror ${./runtime.c} -o dynamic-loader.wasm
    ${sideCC} -O2 -fPIC -c ${./library-a.c} -o a.o
    ${sideCC} -O2 -fPIC -c ${./library-b.c} -o b.o
    ${linkShared {
      name = "libplugin-a.so";
      output = "libplugin-a.so";
      inputs = [ "a.o" ];
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
    ${sideCC} -O2 -msimd128 -fPIC -c ${./cycle-a.c} -o cycle-a.o
    ${sideCC} -O2 -msimd128 -fPIC -c ${./cycle-b.c} -o cycle-b.o
    ${sideCC} -O2 -fPIC -c ${./reentrant-root.c} -o reentrant-root.o
    ${sideCC} -O2 -fPIC -c ${./reentrant-leaf.c} -o reentrant-leaf.o
    ${sideCC} -O2 -fPIC -c ${./reentrant-reject.c} -o reentrant-reject.o
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
    install -Dm644 libplugin-a.so $out/lib/libplugin-a.so
    install -Dm644 libplugin-b.so $out/lib/libplugin-b.so
    install -Dm644 cycle-a.so $out/lib/cycle-a.so
    install -Dm644 cycle-b.so $out/lib/cycle-b.so
    install -Dm644 reentrant-root.so $out/lib/reentrant-root.so
    install -Dm644 reentrant-leaf.so $out/lib/reentrant-leaf.so
    install -Dm644 reentrant-reject.so $out/lib/reentrant-reject.so
    install -Dm644 ${../sdk/LICENSE.MIT} $out/share/licenses/dynamic-loader/LICENSE.MIT
    cp ${musl.src}/COPYRIGHT $out/share/licenses/dynamic-loader/musl-COPYRIGHT
    cp ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT $out/share/licenses/dynamic-loader/compiler-rt-LICENSE.TXT
    mkdir -p $buildMaterials/share/dynamic-loader-materials
    cp ${./runtime.c} ${./library-a.c} ${./library-b.c} ${./cycle-a.c} ${./cycle-b.c} ${./package.nix} $buildMaterials/share/dynamic-loader-materials/
    cp ${./reentrant-root.c} ${./reentrant-leaf.c} ${./reentrant-reject.c} $buildMaterials/share/dynamic-loader-materials/
    ln -s ${sdk-dynamic-loader.buildMaterials} $buildMaterials/share/dynamic-loader-materials/sdk
    ${lib.optionalString (sharedCompiler != null) ''
      cp ${./linux-shared.patch} $buildMaterials/share/dynamic-loader-materials/
      cp ${sharedCompiler.src}/llvm/LICENSE.TXT $out/share/licenses/dynamic-loader/LLVM-LICENSE.TXT
    ''}
    runHook postInstall
  '';
  meta.license = lib.licenses.mit;
  passthru.checks.runtime = vm-test.rawInitramfsTest {
    name = "${finalAttrs.pname}-${platform.wasmArch}";
    init = "${finalAttrs.finalPackage}/dynamic-loader.wasm";
    files = {
      "/plugins/libplugin-b.so" = "${finalAttrs.finalPackage}/lib/libplugin-b.so";
      "/plugins/deps/libplugin-a.so" = "${finalAttrs.finalPackage}/lib/libplugin-a.so";
      "/plugins/cycle-a.so" = "${finalAttrs.finalPackage}/lib/cycle-a.so";
      "/plugins/cycle-b.so" = "${finalAttrs.finalPackage}/lib/cycle-b.so";
      "/plugins/reentrant-root.so" = "${finalAttrs.finalPackage}/lib/reentrant-root.so";
      "/plugins/reentrant-leaf.so" = "${finalAttrs.finalPackage}/lib/reentrant-leaf.so";
      "/plugins/reentrant-reject.so" = "${finalAttrs.finalPackage}/lib/reentrant-reject.so";
    };
  };
})
