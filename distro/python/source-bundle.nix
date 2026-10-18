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
                pkgs.diffutils
                pkgs.gnutar
                pkgs.nodejs
              ];
            }
            ''
              (cd ${bundle} && sha256sum --check SHA256SUMS)
              (cd ${python} && sha256sum --check ${bundle}/BINARY_SHA256SUMS)
              node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
                ${python}/usr/bin/python3.13 ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
              tar -xOzf ${bundle}/python-selected-sources.tar.gz sources/python/LICENSE | cmp - ${python.src}/LICENSE
              tar -xOzf ${bundle}/python-selected-sources.tar.gz build-materials/SHA256SUMS | cmp - ${python.buildMaterials}/SHA256SUMS
              ${pkgs.lib.concatMapStringsSep "\n" (component: ''
                tar -xOzf ${bundle}/python-selected-sources.tar.gz recipes/${component.name}/package.nix \
                  | cmp - ${component.recipeDirectory}/package.nix
                ${pkgs.lib.concatImapStringsSep "\n" (number: patch: ''
                  tar -xOzf ${bundle}/python-selected-sources.tar.gz patches/${component.name}/${
                    pkgs.lib.fixedWidthNumber 3 (number - 1)
                  }.patch \
                    | cmp - ${patch}
                '') (component.package.patches or [ ])}
              '') components}
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
