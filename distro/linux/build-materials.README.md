<!-- SPDX-License-Identifier: MIT -->

# Linux/Wasm build materials

This directory accompanies the adjacent `vmlinux.wasm`. `kernel.config` is the
actual final Kbuild `.config`, copied after building that kernel, including the
selected address width, debug profile and optional test configuration.
`COPYING` and the full `LICENSES/` tree are copied unchanged from that source.
They do not relicense the kernel or the surrounding JavaScript host.

`build.json` records the selected source and LLVM toolchain store identities.
Join each identity's two `hashParts`, a hyphen and `name` to recover its store
basename. Splitting the hash avoids retaining complete build inputs through
Nix reference scanning. These identities are provenance, not public download
URLs or a complete dependency inventory. `package.nix` is the integration
recipe, accompanied by its `fetch-source.nix` helper; its default source pin is
not necessarily the selected source when an override was used. Rebuilding also
requires the matching distro sources,
flake.lock, Nix dependencies and compiler sources.

From the kernel package root, verify the binary and these materials with:

```sh
sha256sum --check linux-build/SHA256SUMS
```

This is not a full GPL corresponding-source archive or a statement of complete
distribution compliance. Distributors must still provide the exact kernel
source, applicable patches and build dependencies/instructions as required by
their distribution. The Linux syscall exception preserves normal user-program
licensing boundaries; it does not make kernel implementation code MIT.
