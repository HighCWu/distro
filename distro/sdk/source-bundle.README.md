<!-- SPDX-License-Identifier: MIT -->

# Selected SDK source inputs

Run `sha256sum --check SHA256SUMS` in this directory. The deterministic
`sdk-selected-sources.tar.gz` contains the same installed entry points,
configuration, notices and selected recipes as the SDK build-material archive,
plus the full selected Linux, musl, LLVM toolchain/runtime and Meson source
input trees. It contains no compiler or runtime binaries. These are original
selected input trees, not a snapshot of a post-patch build directory.

The final `sdk-selected-sources.json` records the platform, source store
identities and each component's `sourceArchiveRoots` path. Identical resolved
source directories are stored only once (normally the two LLVM inputs);
different roots remain separate. No link to a missing store tree is used as a
substitute for the source directory. Source-internal symbolic links retain
their targets without following them, hidden files are included, hardlinked
files are stored as independent regular bytes, and metadata is normalized.

The public verifier compares every member's ordered name, type, metadata and
bytes against independently selected inputs. It never extracts the archive.
The MIT exporter/verifier is included at `recipes/sdk/build-materials.py`:
`source-verify SPEC ARCHIVE` requires the original selection spec and actual
inputs; downloading a checksum does not authenticate a source. Do not execute
scripts or extract untrusted archives merely because checksums match.

This is NOT complete corresponding source for a whole release, an SBOM, a
relocatable SDK, an offline rebuild environment, a source signature or release
approval. Nixpkgs transformations, build-machine dependencies, a full matching
distro checkout, all configured patches/hooks and durable release hosting
still require separate delivery and audit. Selected recipes include the SDK's
Meson patch and its modification notice, but this exporter does not discover
arbitrary overrides or apply patches. Installed scripts/profile retain their
original Nix paths. Linux's source tree here does not replace a kernel
binary's matching final config and complete build/source materials. All
upstream licenses remain applicable; SDK-owned collection code uses MIT.
Public source-check artifacts additionally include `distro-checkout.tar.gz`,
the matching committed distro recipe tree under `distro/`, including its flake
lock, scripts, patches and notices. Its Git archive commit comment is checked
against the workflow SHA, and every tracked blob's bytes, type and executable
mode are compared with Git objects without extracting files. Missing/changed
members from export-ignore/export-subst attributes are rejected. It excludes
Git history and submodule contents (a tracked submodule is rejected, not silently
omitted). Dirty worktree files cannot substitute for committed recipe bytes.
The workflow appends this archive's checksum to the artifact's SHA256SUMS;
the standalone Nix sourceBundle output does not include this Git-based archive.
This addition supplies the matching distro checkout, not the remaining build
dependencies, a signature, or proof of a complete corresponding-source closure.
Temporary Actions artifacts are validation artifacts, not durable releases.
