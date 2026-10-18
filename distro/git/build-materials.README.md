<!-- SPDX-License-Identifier: MIT -->

# Selected Git build records

This directory records the selected Git build's generated Makefile tracking
files, integration recipe, ordered patches, compiler identification, selected
build flags and source/dependency identities. The generated files are data:
do not source or execute them. Build paths may refer to the original Nix store
and are not a relocatable or offline toolchain.
`GIT-LDFLAGS.status` records whether upstream produced `GIT-LDFLAGS`; its Makefile
can omit that tracking file when the effective `ALL_LDFLAGS` is empty. The
compiler-wrapper link flags are separately retained in the whitelisted
`toolchain-environment.nul`, and command-line additions in
`linux-wasm-make-arguments.nul`, as NUL-separated data.

`SHA256SUMS` covers these records. `BUILD_STAGE_BINARY_SHA256SUMS` records only
the bytes at collection time: later Wasm strip hooks can still change them.
It must not be used to identify the final installed binaries. The independent
CI verification output's `BINARY_SHA256SUMS` hashes the completed Git program
and HTTP helper, with paths relative to the runtime output; it also checks
their declared Wasm memory ABI.
The binary files themselves are not included in this artifact. A `verification/`
directory, when supplied by CI, records the manifests checked by that job.

This is not complete corresponding source, a source offer, an SBOM, an offline
rebuild environment, a license-compatibility assessment or release approval.
In particular, Git's HTTP helper still statically links OpenSSL through
libcurl even though Git uses `NO_OPENSSL`. No linking exception is inferred.
Preserve the actual licenses and satisfy all source/distribution obligations
before distributing binaries. Git's original COPYING applies to its contents;
the integration's MIT tools do not relicense Git or linked dependencies.
