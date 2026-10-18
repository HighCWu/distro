# SPDX-License-Identifier: MIT
{
  pkgs,
  git,
  dependencies,
  platform,
}:
let
  components = [
    {
      name = "git";
      package = git;
      recipeDirectory = ./.;
    }
  ]
  ++ dependencies;
  spec = pkgs.writeText "git-selected-source-inputs.json" (
    builtins.toJSON {
      schemaVersion = 1;
      inherit (platform) addressBits maximumMemoryBytes;
      archiveTools = {
        "exporter.py" = "${../python/source-bundle.py}";
        "verifier.py" = "${../python/verify-source-bundle.py}";
        "LICENSE-MIT.txt" = "${../sdk/LICENSE.MIT}";
      };
      components = map (component: {
        inherit (component) name recipeDirectory;
        sourcePath = toString component.package.src;
        sourceIdentity = builtins.baseNameOf "${component.package.src}";
        patchPaths = map toString (component.package.patches or [ ]);
      }) components;
    }
  );
  bundle =
    pkgs.runCommand "git-wasm${toString platform.addressBits}-selected-sources"
      {
        allowedReferences = [ ];
        passthru.check =
          pkgs.runCommand "git-wasm${toString platform.addressBits}-source-bundle-check"
            {
              passthru.ci.heavy = true;
              nativeBuildInputs = [ pkgs.nodejs ];
            }
            ''
              (cd ${bundle} && sha256sum --check SHA256SUMS)
              (cd ${git} && sha256sum --check ${bundle}/BINARY_SHA256SUMS)
              for program in usr/bin/git usr/libexec/git-core/git-remote-http; do
                node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
                  ${git}/"$program" ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
              done
              ${pkgs.python313}/bin/python3 -B ${../python/verify-source-bundle.py} --profile git \
                ${spec} ${git.buildMaterials} ${bundle}/git-selected-sources.tar.gz
              touch $out
            '';
      }
      ''
        mkdir $out
        ${pkgs.python313}/bin/python3 -B ${../python/source-bundle.py} --profile git \
          ${spec} ${git.buildMaterials} "$out/git-selected-sources.tar.gz"
        cp ${./source-bundle.README.md} "$out/README.md"
        (cd ${git} && sha256sum usr/bin/git usr/libexec/git-core/git-remote-http) >"$out/BINARY_SHA256SUMS"
        cd $out
        sha256sum git-selected-sources.tar.gz README.md BINARY_SHA256SUMS >SHA256SUMS
      '';
in
bundle
