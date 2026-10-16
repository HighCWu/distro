# SPDX-License-Identifier: MIT
{
  pkgs,
  busybox,
  addressBits,
  maximumMemoryBytes,
}:
assert
  (busybox.patches or [ ]) == [ ]
  || throw "BusyBox source bundle does not yet collect configured patches";
let
  bundle =
    pkgs.runCommand "${busybox.name}-source-bundle"
      {
        allowedReferences = [ ];
        nativeBuildInputs = [
          pkgs.gnutar
          pkgs.gzip
          pkgs.coreutils
          pkgs.gnused
        ];
        passthru.check =
          pkgs.runCommand "${busybox.name}-source-bundle-check"
            {
              passthru.ci.heavy = true;
              nativeBuildInputs = [
                pkgs.gnutar
                pkgs.coreutils
                pkgs.gnugrep
                pkgs.jq
                pkgs.nodejs
              ];
            }
            ''
              (cd ${bundle} && sha256sum --check SHA256SUMS)
              (cd ${busybox} && sha256sum --check ${bundle}/BINARY_SHA256SUMS)
              (cd ${busybox.buildMaterials} && sha256sum --check SHA256SUMS)
              jq --exit-status '.schemaVersion == 1 and .addressBits == ${toString addressBits}' \
                ${busybox.buildMaterials}/build.json
              grep -qx 'CONFIG_NOMMU=y' ${busybox.buildMaterials}/busybox.config
              grep -qx 'CONFIG_HUSH=y' ${busybox.buildMaterials}/busybox.config
              node ${busybox.buildMaterials}/check-binary.mjs ${busybox.buildMaterials}/wasm_binary.ts \
                ${busybox}/bin/busybox ${toString addressBits} ${toString maximumMemoryBytes}
              tar -tzf ${bundle}/busybox-source.tar.gz > members
              grep -qx 'busybox/Makefile' members
              grep -qx 'build-materials/busybox.config' members
              tar -xOzf ${bundle}/busybox-source.tar.gz busybox/LICENSE | cmp - ${busybox.src}/LICENSE
              tar -xOzf ${bundle}/busybox-source.tar.gz build-materials/busybox.config | cmp - ${busybox.buildMaterials}/busybox.config
              test ! -e ${busybox}/busybox.config
              touch $out
            '';
      }
      ''
        mkdir $out
        bash ${./source-bundle.sh} ${busybox.src} ${busybox.buildMaterials} "$out/busybox-source.tar.gz"
        cp ${./source-bundle.README.md} "$out/README.md"
        (cd ${busybox} && sha256sum bin/busybox) > "$out/BINARY_SHA256SUMS"
        cd $out
        sha256sum busybox-source.tar.gz README.md BINARY_SHA256SUMS > SHA256SUMS
      '';
in
bundle
