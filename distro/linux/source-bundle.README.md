<!-- SPDX-License-Identifier: MIT -->

# Selected Linux source and build materials

`linux-source.tar.gz` contains the complete selected Linux source tree under
`linux/` and that kernel's final configuration, original license texts and
integration build materials under `build-materials/`. Source symlink targets
are preserved. The source is the selected derivation input, not a fresh copy
of a moving branch. Verify the compressed archive with `sha256sum -c SHA256SUMS`.

The inner build-material checksums describe the corresponding binary package;
they include `vmlinux.wasm`, which is intentionally not duplicated here.
`build-materials/build.json` records the selected source/toolchain identities
and address-width/profile settings. Use the matching distro checkout and
flake.lock with the recorded configuration, recipe and toolchain. This archive
does not contain all distro/LLVM/Nix dependencies, compiler source, npm host
sources, an SBOM or an independently validated offline rebuild environment.
The exporter rejects a nonempty configured `patches` list rather than silently
omitting it. Custom build hooks/overrides still require a distributor audit:
this is the selected source input, not a snapshot of an arbitrarily modified
post-patch build workspace.

Providing this source archive does not by itself establish complete GPL
compliance for an entire release or rootfs. Distributors must audit their
actual binary/source combination, patches, build/install scripts, dependency
licenses and distribution obligations. Short-lived CI artifacts are for
validation, not a substitute for versioned, durably available release sources.
