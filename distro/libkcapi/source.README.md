<!-- SPDX-License-Identifier: MIT -->
# libkcapi static Wasm build materials

This bundle contains the unmodified upstream 1.5.1 source archive, local build
recipe and Wasm-only symbol-version compatibility patch. Upstream release:
https://www.chronox.de/libkcapi/releases/1.5.1/index.html
and repository: https://github.com/smuellerDD/libkcapi/tree/v1.5.1 .

The archive SHA-256 is
`bd2e4c5731380922a8a6a45cc6dce0477bab000c917086f802d983d65441599a`.
COPYING permits BSD-3-Clause or GPLv2; this recipe selects the BSD option and
retains COPYING, COPYING.bsd and COPYING.gplv2. Local additions are MIT, not a
relicense of upstream code. musl/compiler-rt notices are installed separately.

The static library and kcapi-hasher/kcapi-dgst are built from upstream sources.
Only the internal ELF symbol-version macros are adapted for Wasm: the existing
default API is an alias to its existing implementation, while legacy ELF symbol
versions are not a Wasm dynamic ABI. Native ELF builds retain upstream macros.
No crypto implementation, Netlink query, syscall wrapper or application C file
is replaced. The build uses upstream's disable-werror option for its GCC-specific
warning/optimization flags under Clang. No application is run on the build host.

The tools require standard AF_ALG and NETLINK_CRYPTO. Kernel algorithm selection
still determines available algorithms; this is not AEAD, AIO, dynamic linking or
FIPS certification. File-output paths that require MAP_SHARED remain outside the
current direct-memory mapping support; normal stdout/redirection remains available.

SHA256SUMS identifies build materials. BINARY_SHA256SUMS is computed from the final
stripped executables, not intermediate files. The bundle is not a complete SDK or
corresponding-source archive for all runtime dependencies.
