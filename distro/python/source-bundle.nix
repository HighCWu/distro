# SPDX-License-Identifier: MIT
{
  pkgs,
  python,
  dependencies,
  platform,
}:
let
  components = [
    {
      name = "python";
      package = python;
      recipeDirectory = ./.;
    }
  ]
  ++ dependencies;
  spec = pkgs.writeText "python-selected-source-inputs.json" (
    builtins.toJSON {
      schemaVersion = 1;
      inherit (platform) addressBits maximumMemoryBytes;
      components = map (component: {
        inherit (component) name recipeDirectory;
        sourcePath = toString component.package.src;
        sourceIdentity = builtins.baseNameOf "${component.package.src}";
        patchPaths = map toString (component.package.patches or [ ]);
      }) components;
    }
  );
  bundle =
    pkgs.runCommand "python-wasm${toString platform.addressBits}-selected-sources"
      {
        allowedReferences = [ ];
        passthru.check =
          pkgs.runCommand "python-wasm${toString platform.addressBits}-source-bundle-check"
            {
              passthru.ci.heavy = true;
              nativeBuildInputs = [
                pkgs.coreutils
                pkgs.nodejs
              ];
            }
            ''
              (cd ${bundle} && sha256sum --check SHA256SUMS)
              (cd ${python} && sha256sum --check ${bundle}/BINARY_SHA256SUMS)
              node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
                ${python}/usr/bin/python3.13 ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
              ${pkgs.python313}/bin/python3 -B ${./verify-source-bundle.py} ${spec} \
                ${python.buildMaterials} ${bundle}/python-selected-sources.tar.gz
              touch $out
            '';
      }
      ''
        mkdir $out
        ${pkgs.python313}/bin/python3 -B ${./source-bundle.py} ${spec} \
          ${python.buildMaterials} "$out/python-selected-sources.tar.gz"
        cp ${./source-bundle.README.md} "$out/README.md"
        (cd ${python} && sha256sum usr/bin/python3.13) > "$out/BINARY_SHA256SUMS"
        cd $out
        sha256sum python-selected-sources.tar.gz README.md BINARY_SHA256SUMS > SHA256SUMS
      '';
in
bundle
