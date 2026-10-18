# SPDX-License-Identifier: MIT
{
  pkgs,
  platform,
  sdk,
  profileCheck,
  profileConfig,
  licenseSources,
}:
let
  spec = pkgs.writeText "sdk-build-material-inputs.json" (
    builtins.toJSON {
      schemaVersion = 1;
      inherit (platform) addressBits targetTriple maximumMemoryBytes;
      sources = builtins.mapAttrs (_: toString) licenseSources;
      files = {
        "installed/bin/wasm-linux-cc" = "${sdk}/bin/wasm-linux-cc";
        "installed/bin/wasm-linux-c++" = "${sdk}/bin/wasm-linux-c++";
        "installed/bin/wasm-linux-pkg-config" = "${sdk}/bin/wasm-linux-pkg-config";
        "installed/bin/wasm-linux-configure" = "${sdk}/bin/wasm-linux-configure";
        "installed/bin/wasm-linux-sdk-info" = "${sdk}/bin/wasm-linux-sdk-info";
        "installed/profile.json" = "${sdk}/share/linux-wasm-sdk/profile.json";
        "installed/config.site" = "${sdk}/share/linux-wasm-sdk/config.site";
        "installed/linux-wasm.cmake" = "${sdk}/share/cmake/linux-wasm.cmake";
        "installed/linux-wasm.ini" = "${sdk}/share/meson/linux-wasm.ini";
        "configuration/compiler.cfg" = "${profileConfig}";
        "configuration/clang++.cfg" = "${sdk}/bin/clang++.cfg";
        "integration/flake.nix" = "${../../flake.nix}";
        "integration/flake.lock" = "${../../flake.lock}";
        "integration/platform.nix" = "${../platform.nix}";
        "integration/stdenv.nix" = "${../stdenv.nix}";
        "integration/default.nix" = "${../default.nix}";
      };
      trees = {
        licenses = "${sdk}/share/linux-wasm-sdk/licenses";
        "recipes/sdk" = "${./.}";
        "recipes/llvm-toolchain" = "${../llvm-toolchain}";
        "recipes/llvm-runtimes" = "${../llvm-runtimes}";
        "recipes/musl" = "${../musl}";
        "recipes/linux" = "${../linux}";
        "recipes/sysroot" = "${../sysroot}";
        "recipes/sysroot-base" = "${../sysroot-base}";
      };
    }
  );
  sourceBundle =
    pkgs.runCommand "sdk-selected-sources-${platform.wasmArch}"
      {
        allowedReferences = [ ];
        passthru.check =
          pkgs.runCommand "sdk-selected-sources-check-${platform.wasmArch}"
            {
              passthru.ci.heavy = true;
            }
            ''
              test -e ${bundle.check}
              (cd ${sourceBundle} && ${pkgs.coreutils}/bin/sha256sum --check SHA256SUMS)
              ${pkgs.python313}/bin/python3 -B ${./build-materials.py} source-verify ${spec} \
                ${sourceBundle}/sdk-selected-sources.tar.gz
              touch $out
            '';
      }
      ''
        test -e ${bundle.check}
        mkdir $out
        ${pkgs.python313}/bin/python3 -B ${./build-materials.py} source-export ${spec} \
          "$out/sdk-selected-sources.tar.gz"
        cp ${./source-bundle.README.md} "$out/README.md"
        cd $out
        ${pkgs.coreutils}/bin/sha256sum sdk-selected-sources.tar.gz README.md > SHA256SUMS
      '';
  bundle =
    pkgs.runCommand "sdk-build-materials-${platform.wasmArch}"
      {
        allowedReferences = [ ];
        passthru.sourceBundle = sourceBundle;
        passthru.check =
          pkgs.runCommand "sdk-build-materials-check-${platform.wasmArch}"
            {
              passthru.ci.heavy = true;
            }
            ''
              (cd ${bundle} && ${pkgs.coreutils}/bin/sha256sum --check SHA256SUMS)
              ${pkgs.python313}/bin/python3 -B ${./build-materials.py} verify ${spec} \
                ${bundle}/sdk-build-materials.tar.gz
              touch $out
            '';
      }
      ''
        # Verify the actual installed profile and selected license checksums first.
        test -s ${profileCheck}/profile.json
        ${pkgs.python313}/bin/python3 -B ${./.}/build-materials-test.py
        mkdir $out
        ${pkgs.python313}/bin/python3 -B ${./build-materials.py} export ${spec} \
          "$out/sdk-build-materials.tar.gz"
        cp ${./build-materials.README.md} "$out/README.md"
        cd $out
        ${pkgs.coreutils}/bin/sha256sum sdk-build-materials.tar.gz README.md > SHA256SUMS
      '';
in
bundle
