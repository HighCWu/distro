<!-- SPDX-License-Identifier: MIT -->

# Selected Git source inputs

`git-selected-sources.tar.gz` contains the exact selected Git, zlib, curl and
OpenSSL source input trees, their integration recipe directories and ordered
configured patches, plus this Git build's selected configuration records.
Original license files and declarations remain unchanged. The public index
records input identities rather than machine-local source paths.
`archive-tools/` preserves the actual exporter, verifier and MIT text used for
this archive; their scripts support the explicit `--profile git` selection.

The collector uses the program's final source and patch attributes, compares
the primary recipe and ordered patches with the build records, and checks
their manifest before publication. CI compares every archive member's bytes,
type, mode and symbolic-link target with those exact inputs without extraction;
duplicates, missing/extra members and corrupt compressed streams are rejected.
Source symlinks remain links, not copied targets; inspect them before extracting
or building. The archive is not a safe executable or an extraction sandbox.

`BINARY_SHA256SUMS` identifies the final installed Git and HTTP helper relative
to their runtime output; binaries are not bundled here. `SHA256SUMS` covers the
published files. Short-lived CI artifacts are not a durable source-offer channel.

This selection is not complete corresponding source, an SBOM, a source offer,
an offline rebuild environment, a legal assessment or binary release approval.
It omits the full compiler/runtime/libc closure, Nix build environment and other
system components. Recipes may refer to files outside the collected directories.
Custom build hooks or added dependencies require separate collection and review.

Git's `NO_OPENSSL` still does not remove OpenSSL linked through libcurl; this
archive grants or infers no linking exception. Review license compatibility and
all applicable source, notice and distribution requirements before releasing
binaries. Project MIT tooling does not relicense Git or any dependencies.
