<!-- SPDX-License-Identifier: MIT -->

# Selected Python and dependency sources

`python-selected-sources.tar.gz` contains the exact CPython source input and
the seven selected statically linked dependency source inputs under `sources/`:
zlib, bzip2, xz, SQLite, Readline, ncurses and OpenSSL. These are derivation
inputs, not new downloads of moving branches. `recipes/` includes the selected
local integration directories, and `patches/` records actual configured
patches in order, including patches supplied by derivation overrides.
`build-materials/` is the actual interpreter configuration/patch output.
`selected-sources.json` records platform bounds, source identities and patch order.
`archive-tools/` explicitly preserves the actual exporter, verifier and complete
MIT text for this project's integration tooling. Those scripts accept the
default Python profile or explicit `--profile python`; they do not relicense
the upstream sources. Older schema-v1 Python selections without archive tools
remain readable; current recipes include all three files, never a partial set.
The trees are pre-patch inputs, not arbitrary post-patch workspaces. Original
symlink targets are preserved without following source links during archival.
Regular files are archived independently; Nix store hardlink deduplication does
not introduce cross-component archive links. Hardlink topology is not retained.

The source-bundle check independently enumerates every selected source,
recipe and material tree and compares the complete member inventory, file
bytes, modes, symlink targets, ordered patches and public index. File content
is compared in bounded chunks without extraction or following source-tree
symlinks. Unexpected, missing or repeated members, changed gzip integrity and
appended archives fail the check. This verifies the collected inputs, not
whether the selected inputs satisfy all build or licensing requirements.

Check companion files with `sha256sum -c SHA256SUMS`. Verify the separate
`BINARY_SHA256SUMS` from the matching runtime output root: it identifies the
final installed `usr/bin/python3.13`, not a temporary build-tree executable.
The archive contains no interpreter binary. It is kept out of runtime images.
Archive metadata is stable for identical inputs; checksum manifests bind bytes,
not origin authenticity, legal sufficiency or successful offline rebuilding.

Use the matching distro checkout and flake.lock for the enclosing package
scope, stdenv, SDK, compiler and host tools. They are not fully collected here.
This bundle does not include complete musl/compiler-rt/toolchain/kernel source
closures, all Nixpkgs hooks, host dependencies, a binary SBOM, an offline build
environment or all release-wide source/install scripts. Custom hooks and source
overrides require separate review. Shipping this selected bundle alone is not
a claim of complete corresponding-source delivery or GPL compliance.

The Python interpreter statically links GNU Readline. CPython, Readline and
all other included components retain their actual upstream licenses; our MIT
exporter and recipes do not relicense them. Preserve required notices and
provide all required corresponding source and build/install information before
redistributing the interpreter or a complete system. Short-lived CI artifacts
are not a durable versioned source release. Independent user applications keep
the ordinary Linux licensing boundary, subject to their own dependencies.
