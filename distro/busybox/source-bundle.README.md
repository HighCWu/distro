<!-- SPDX-License-Identifier: MIT -->

# Selected BusyBox source and build materials

`busybox-source.tar.gz` contains the selected upstream source tree under
`busybox/` and its build materials under `build-materials/`. The source tree
is the original derivation input. When present, the selected local patch is
stored in `build-materials/` and covered by `SHA256SUMS`. To reproduce the
patched package, run this from the archive root:

```sh
cd busybox
patch -p1 < ../build-materials/hush-condition-status.patch
```

Verify the archive and companion files with `sha256sum -c SHA256SUMS`.
`BINARY_SHA256SUMS` identifies the installed `bin/busybox` after strip/fixup;
verify it from the matching binary package root. The materials are a separate
Nix output and are not installed into the runtime root image.

BusyBox is GPL-2.0-only; its upstream license text is included as `LICENSE`.
The binary also carries musl and compiler-rt notices under
`/share/licenses/busybox/`. The repository's MIT license applies to its build
and test infrastructure, not to BusyBox or third-party runtime code.
