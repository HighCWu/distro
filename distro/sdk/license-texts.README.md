<!-- SPDX-License-Identifier: MIT -->

# Selected SDK license texts

These files are copied unmodified from the exact source inputs selected for
the toolchain and sysroot. `sources.json` identifies those inputs using the
store hash split into two `hashParts` and the remaining `name`: join the hash
parts, then append a hyphen and the name to reconstruct the store basename.
The split matters because Nix scans bare store hashes as references too.
`SHA256SUMS` verifies the installed files. This directory does
not retain the complete upstream source trees in the SDK runtime closure.

The musl COPYRIGHT includes its upstream attribution and component exceptions.
The Linux COPYING and LICENSES directory accompany the UAPI headers; this SDK
does not link Linux kernel implementation code into applications. LLVM project
license files retain their upstream exceptions and notices. SDK-owned wrapper
and integration code uses the MIT text in SDK-MIT.txt; this does not relicense
any upstream component.

This is a partial license-material bundle, not a complete SBOM, dependency
inventory, legal determination or GPL corresponding-source archive. In
particular, host tool dependencies, Meson, and additional application libraries
need their own license/notice inventory. Per-file notices in upstream source
also remain applicable; these top-level texts are not a substitute for auditing
the files and binaries actually distributed. Source store identities are not
a promise of publicly available corresponding source.
