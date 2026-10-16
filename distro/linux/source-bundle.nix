# SPDX-License-Identifier: MIT
{ pkgs, linux }:
assert
  (linux.patches or [ ]) == [ ]
  || throw "Linux source bundle does not yet collect configured patches; keep them in the selected source tree or extend the exporter";
let
  bundle =
    pkgs.runCommand "${linux.pname}-source-bundle"
      {
        allowedReferences = [ ];
        nativeBuildInputs = [
          pkgs.gnutar
          pkgs.gzip
          pkgs.coreutils
          pkgs.gnused
        ];
        passthru.check =
          pkgs.runCommand "${linux.pname}-source-bundle-check"
            {
              passthru.ci.heavy = true;
              nativeBuildInputs = [
                pkgs.gnutar
                pkgs.coreutils
                pkgs.gnugrep
              ];
            }
            ''
                      test -e ${linux.checks.build-materials}
              (cd ${bundle} && sha256sum --check SHA256SUMS)
              tar -tzf ${bundle}/linux-source.tar.gz > members
              grep -qx 'linux/Makefile' members
                      grep -qx 'build-materials/kernel.config' members
              tar -xOzf ${bundle}/linux-source.tar.gz linux/COPYING | cmp - ${linux.src}/COPYING
              tar -xOzf ${bundle}/linux-source.tar.gz build-materials/kernel.config | cmp - ${linux}/linux-build/kernel.config
                      touch $out
            '';
      }
      ''
        mkdir $out
        bash ${./source-bundle.sh} ${linux.src} ${linux} "$out/linux-source.tar.gz"
        cp ${./source-bundle.README.md} "$out/README.md"
        cd $out
        sha256sum linux-source.tar.gz README.md > SHA256SUMS
      '';
in
bundle
