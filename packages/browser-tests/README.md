# Browser tests

This package boots the packaged `@lowland/guest` runtime in Playwright's
Chromium, Firefox, and WebKit builds. The server supplies the COOP and COEP
headers required by shared WebAssembly memory. Browser binaries, fonts, npm
packages, rootfs, initramfs, and kernel assets all come from Nix store paths;
the tests do not fetch anything at runtime.

The npm `@playwright/test` version is an exact pin. `package.nix` compares it
with `playwright-driver.version` at evaluation time and fails with both
versions in the error if they differ.

## Running

Each engine is an ordinary flake check and runs inside the Nix build sandbox:

```console
nix build .#checks.x86_64-linux.browser-tests-check-chromium -L
nix build .#checks.x86_64-linux.browser-tests-check-firefox -L
nix build .#checks.x86_64-linux.browser-tests-check-webkit -L
```

The generic check discovery in `checks.nix` exposes these checks and the
generic CI build matrix runs them. There is no separate browser-test app or CI
job.

The wasm32 suite covers packaged runtime boot, `uname`, clean shutdown,
Worker scheduler handoff, spawn, private-memory snapshots, OPFS storage and
virtio-fs. It catches SAB/COOP/COEP/Worker/module-loading regressions that only
show up on a real browser engine. Site/service-worker integration checks are
separate checks rather than part of every engine's suite.

Memory64 has separate Chromium and Firefox checks:

```console
nix build .#checks.x86_64-linux.browser-tests-check-memory64-chromium -L
nix build .#checks.x86_64-linux.browser-tests-check-memory64-firefox -L
```

These currently check kernel startup through its Linux version banner; they
do not execute the wasm32 userspace suite or the experimental EROFS initialized
copy tests. Passing a banner smoke test is not evidence of browser coverage for
file reads, mapping lifecycle, signals or process teardown. The EROFS tests
currently run under Node in separate `mmap-benchmark[-wasm64]-check-erofs`
checks, using an opt-in test kernel. Standard file mmap remains unsupported.

The engine versions are pinned by nixpkgs and the matching Playwright driver.
No experimental browser feature flags are set by this suite; a pass does not
establish compatibility with every browser vendor's latest distribution.

## Headless graphics

The checks use nixpkgs' Mesa EGL vendor and DRI drivers with software
rendering. This keeps the browser environment independent of host GPU drivers
and works on GitHub's Ubuntu runners, inside the Nix sandbox, and on NixOS
without relying on `/run/opengl-driver`.
