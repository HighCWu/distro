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

`stdenv-wasm64` is available for additional package ports. The surrounding
default package scope remains wasm32: explicitly select matching wasm64
dependencies rather than passing a default-scope library to a wasm64 build.
This bring-up does not switch the published repository, system image, or default
npm package to wasm64.

BusyBox remains GPL-2.0-only; selecting another architecture does not relicense
it. Its source revision is pinned in `package.nix`. Distribution must fulfill
BusyBox's corresponding-source obligations as well as the applicable musl and
LLVM runtime notices. License metadata alone is not a source-delivery mechanism.
The project's own build and test infrastructure follows the repository's MIT
license; that does not change the licenses of packaged software.
