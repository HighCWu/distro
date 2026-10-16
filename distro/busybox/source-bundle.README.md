<!-- SPDX-License-Identifier: MIT -->

# Selected BusyBox source and build materials

`busybox-source.tar.gz` contains the complete selected source tree under
`busybox/` and the final `.config`, license, integration recipe, material
exporter, ABI validator, notice-installation text and build-input identities
under `build-materials/`. The source is
the exact derivation input, not a fresh download of a moving branch. Source
symlink targets and hard links are preserved. Archive headers are stable.

Verify the archive and companion files with `sha256sum -c SHA256SUMS`.
`BINARY_SHA256SUMS` separately identifies the installed `bin/busybox` after
strip/fixup; verify it from the matching binary package root. The materials
are a separate Nix output and are not installed into the runtime root image.

Rebuild using the matching distro checkout and flake.lock, selected source,
configuration and toolchain. This archive does not include musl/compiler-rt
source trees, the compiler, Linux headers, all Nix dependencies, an SBOM or a
validated offline build environment. The package's runtime license texts
remain under `/share/licenses/busybox/`. BusyBox remains GPL-2.0-only; the MIT
license on our exporter does not relicense BusyBox or its modifications.

The exporter rejects configured patches rather than silently omitting them.
Custom hooks and source overrides require separate review: the source input
is not a snapshot of an arbitrary post-patch workspace. Providing this bundle
does not establish complete corresponding-source delivery or release-wide
GPL compliance. Audit the actual binary/source combination and all required
build/install scripts and dependencies. Short-lived CI artifacts are not a
substitute for durably available versioned release sources.
