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
file reads, mapping lifecycle, signals or process teardown.

## Experimental EROFS copy lifecycle

Independent suites use the opt-in test kernel and the same C test/initramfs
and EROFS image as the Node `mmap-benchmark[-wasm64]-check-erofs` checks:

```console
nix build .#checks.x86_64-linux.browser-tests-check-erofs-wasm32-chromium -L
nix build .#checks.x86_64-linux.browser-tests-check-erofs-wasm32-firefox -L
nix build .#checks.x86_64-linux.browser-tests-check-erofs-wasm64-chromium -L
nix build .#checks.x86_64-linux.browser-tests-check-erofs-wasm64-firefox -L
```

They boot four CPUs with one snapshot disk and one ordinary read-only disk,
wait for the C program's pass/fail marker (not just a startup banner), record
the browser version and require machine shutdown. The program checks source
admission, content/zero tails, private callback clone, normal/fatal exit after
publication, concurrent copies, fd reuse and survival after source unmount.
The browser watchdog bounds execution; a delayed boot is closed if it completes
after the timeout. These suites do not enable test features in the ordinary
browser checks and do not prove safety of cancellation during actual device I/O.
Standard file mmap remains unsupported. The initial four-engine/profile CI
matrix passed after the harness formatting correction. Separate Node
`mmap-benchmark[-wasm64]-check-erofs-errors` checks test real read failures from
an intentionally out-of-range EROFS data address; those are not yet included in
the browser suite.

The engine versions are pinned by nixpkgs and the matching Playwright driver.
No experimental browser feature flags are set by this suite; a pass does not
establish compatibility with every browser vendor's latest distribution.

## Headless graphics

The checks use nixpkgs' Mesa EGL vendor and DRI drivers with software
rendering. This keeps the browser environment independent of host GPU drivers
and works on GitHub's Ubuntu runners, inside the Nix sandbox, and on NixOS
without relying on `/run/opengl-driver`.
