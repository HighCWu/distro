<!-- SPDX-License-Identifier: MIT -->

# Selected SDK build materials

Check this directory with `sha256sum --check SHA256SUMS`. The deterministic
`sdk-build-materials.tar.gz` contains the actual installed SDK entry-point
scripts, profile, compiler configuration, config.site, CMake/Meson files,
selected license texts, and selected integration recipes with the distro
flake files. Executable modes, directory modes, owners and timestamps are
normalized; regular file bytes and source symbolic links are preserved.

`sdk-build-materials.json` records the selected pointer width, target triple,
declared linear-memory ceiling and source store identities. Reconstruct each
source store basename by joining its two hashParts, a hyphen and its name.
The full source trees themselves are NOT included. The profile and scripts
retain their exact original Nix store paths; they describe this installation,
not a relocatable SDK. The archive contains no compiler or runtime binaries
and cannot compile or run applications by itself.

The public CI verifier compares the exact member set and each member's bytes,
type and normalized metadata against the independently selected installed SDK,
recipes and notices, rather than trusting an archive's own checksums alone.
The exporter/verifier is included at `recipes/sdk/build-materials.py` with its
MIT license at `recipes/sdk/LICENSE.MIT`. Its `verify SPEC ARCHIVE` mode needs
the original selection spec and actual inputs; checksums alone cannot prove
authenticity or reconstruct missing build inputs. Archives are never extracted
by the verifier. Do not execute archived scripts or extract untrusted archives
merely because they have checksums.

This is NOT full corresponding source, a complete dependency/license inventory,
an SBOM, a source signature, an offline build environment or release approval.
In particular, upstream Linux/musl/LLVM/Meson sources, build-host dependencies,
Nixpkgs transformations and a complete build checkout still need their own
source/provenance delivery. Included recipes may reference other files that
are not part of this selected snapshot. Component licenses remain applicable;
SDK-owned material collection uses MIT, not a relicensing of dependencies.
Temporary Actions artifacts do not replace a release's durable source hosting.
