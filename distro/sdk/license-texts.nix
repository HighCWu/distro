# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  sources,
}:
let
  sourceIndex = pkgs.writeText "sdk-license-sources.json" (
    builtins.toJSON {
      schemaVersion = 1;
      scope = "Selected upstream license texts only; not an SBOM, full dependency license inventory or corresponding-source archive";
      # Nix scans store hashes even without the /nix/store prefix. Split the
      # identity so it can be reconstructed without retaining source trees.
      sourceStoreIdentities = lib.mapAttrs (
        _name: source:
        let
          basename = builtins.baseNameOf (toString source);
        in
        {
          hashParts = [
            (builtins.substring 0 16 basename)
            (builtins.substring 16 16 basename)
          ];
          name = builtins.substring 33 (builtins.stringLength basename) basename;
        }
      ) sources;
    }
  );
in
pkgs.runCommand "linux-wasm-sdk-license-texts"
  {
    passthru.ci.heavy = true;
    allowedReferences = [ ];
    nativeBuildInputs = [ pkgs.findutils ];
  }
  ''
    destination=$out/share/linux-wasm-sdk/licenses
    mkdir -p "$destination"/{musl,linux,llvm-toolchain,llvm-runtimes}
    cp ${sourceIndex} "$destination/sources.json"
    cp ${./license-texts.README.md} "$destination/README.md"
    cp ${./LICENSE.MIT} "$destination/SDK-MIT.txt"
    cp ${sources.musl}/COPYRIGHT "$destination/musl/COPYRIGHT"
    cp ${sources.linux}/COPYING "$destination/linux/COPYING"
    cp -r ${sources.linux}/LICENSES "$destination/linux/"
    for component in llvm clang lld; do
      cp ${sources.llvm-toolchain}/"$component"/LICENSE.TXT \
        "$destination/llvm-toolchain/$component-LICENSE.TXT"
    done
    for component in compiler-rt libcxx libcxxabi libunwind; do
      cp ${sources.llvm-runtimes}/"$component"/LICENSE.TXT \
        "$destination/llvm-runtimes/$component-LICENSE.TXT"
    done
    cd "$destination"
    # Fail closed if an upstream notice disappeared or became empty, and make
    # the selected files independently verifiable after installation.
    find . -type f -empty -print > "$TMPDIR/empty-license-files"
    test ! -s "$TMPDIR/empty-license-files"
    find . -type f -print0 | sort -z | xargs -0 sha256sum > "$TMPDIR/license-sums"
    cp "$TMPDIR/license-sums" SHA256SUMS
    sha256sum --check SHA256SUMS
  ''
