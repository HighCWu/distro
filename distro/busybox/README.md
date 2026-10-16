# BusyBox userland profiles

The default `busybox` package targets wasm32. The opt-in `busybox-wasm64`
package uses the same pinned source and configuration, with a matching wasm64
standard environment, Linux headers, musl sysroot and LLVM runtimes. Neither
profile enables kernel softmmu; both use the current NOMMU execution model.

The wasm64 installed checks use `apk-wasm64` for package architecture and system
assembly, and `image-wasm64` for the BusyBox-based loader. The loader, installed
shell, utilities and kernel must all match; reusing the default wasm32 loader
would not prove a native wasm64 boot.

```console
nix build .#busybox-wasm64 -L
nix build .#checks.x86_64-linux.busybox-wasm64-check-smoke -L
nix build .#checks.x86_64-linux.busybox-wasm64-check-processes -L
nix build .#checks.x86_64-linux.busybox-wasm64-check-networking -L
```

Run heavy builds in public CI rather than rebuilding LLVM and Linux locally:

```console
gh workflow run ci.yml --repo HighCWu/distro --ref YOUR_PUSHED_BRANCH -f heavy-check=busybox-wasm64-check-smoke
```

The checks reuse the existing installed-system corpus and require its final
pass marker and machine closure. Smoke exercises shell expansion/arithmetic,
file operations, pipelines, command substitution, `time` and `ts`. Separate
process and loopback-network checks remain independent results. Merely exposing
these checks does not establish that the wasm64 package builds or passes them.
These are Node runtime checks, not browser or full-distribution certification.

The build also inspects the linked executable before installing it. It requires
exactly one shared `env.memory` import of the selected address width, no defined
memory, and the platform's declared memory ceiling. This is a structural ABI
gate, not evidence of successful execution or a promise that the host can
allocate the declared maximum. Its host-only regression checks both widths and
rejects wrong-width, private, missing/duplicate/defined memories, inconsistent
limits and malformed inputs:

```console
node --test distro/busybox/check-binary.test.mjs
```

`stdenv-wasm64` is available for additional package ports. The surrounding
default package scope remains wasm32: explicitly select matching wasm64
dependencies rather than passing a default-scope library to a wasm64 build.
This bring-up does not switch the published repository, system image, or default
npm package to wasm64.

BusyBox remains GPL-2.0-only; selecting another architecture does not relicense
it. Both profiles install upstream `LICENSE`, the selected musl `COPYRIGHT`,
the selected compiler-rt `LICENSE.TXT` and an explanatory README under
`/share/licenses/busybox/`. The installed smoke check requires all four files
to be nonempty after root assembly; adding this assertion does not itself prove
that the updated image has passed CI.

Its source revision is pinned in `package.nix`. Distribution must fulfill
BusyBox's corresponding-source obligations as well as the applicable musl and
LLVM runtime notices. License metadata alone is not a source-delivery mechanism.
The project's own build and test infrastructure follows the repository's MIT
license; that does not change the licenses of packaged software.

## Selected source and build materials

Both widths expose a separate `buildMaterials` output containing the final
BusyBox `.config`, license, recipe, ABI validator and selected build-input
identities. It is not part of the APK payload or installed system root.
The opt-in `sourceBundle` archives the selected BusyBox source tree together
with those materials, preserving source links and stable archive headers.
It also supplies `BINARY_SHA256SUMS` for the final installed executable after
strip/fixup, separately from the compressed archive's `SHA256SUMS`.

```console
nix build .#busybox-wasm64.buildMaterials -L
nix build .#busybox-wasm64.sourceBundle -L
nix build .#checks.x86_64-linux.busybox-wasm64-check-source-bundle -L
nix build .#checks.x86_64-linux.busybox-check-source-bundle -L
node --test distro/busybox/source-bundle.test.js
```

Keep target builds in public CI. The explicit source-bundle checks compare
archived configuration/license bytes, check both sets of checksums and the
final executable's memory ABI, and require NOMMU/hush configuration. Successful
CI collects a three-day artifact for inspection, not a durable release source
publication. Exposing these checks is not evidence they have passed.

Configured patches are rejected rather than silently omitted. Custom hooks
need their own audit. Read the bundle's README for exclusions: notably it is
not an offline rebuild environment, full linked-runtime source inventory,
SBOM, or proof of complete corresponding-source delivery. Actual release
source availability and dependency obligations remain distributor work.
