# Browser tests

This package tests Linux/Wasm in real Playwright browsers. The main wasm32
suite boots the packaged agent runtime in Chromium, Firefox, and WebKit;
separate wasm32 and wasm64 suites boot C/C++ user programs directly through
`@lowland/kernel` in Chromium and Firefox. The server supplies the COOP and COEP
headers required by shared WebAssembly memory. Browser binaries, fonts, npm
packages, rootfs, initramfs, and kernel assets all come from Nix store paths.
Tests fetch their assets from the local test server, not external services.

The npm `@playwright/test` version is an exact pin. The Nix browser-suite
definition compares it with `playwright-driver.version` through
`distro/npm/playwright.nix` at evaluation time and fails with both versions in
the error if they differ.

## Running

Run these commands from the distro checkout. Each engine is an ordinary flake
check and runs inside the Nix build sandbox:

```console
nix build .#checks.x86_64-linux.browser-tests-check-chromium -L
nix build .#checks.x86_64-linux.browser-tests-check-firefox -L
nix build .#checks.x86_64-linux.browser-tests-check-webkit -L
```

The generic check discovery in `checks.nix` exposes these checks. Public GitHub
Actions can run one heavy check without dispatching the full matrix:

```console
gh workflow run ci.yml --repo HighCWu/distro --ref YOUR_PUSHED_BRANCH -f heavy-check=browser-tests-check-memory64-chromium
```

Local development does not require rebuilding Linux, LLVM or all browser suites;
use the public CI for heavy builds and keep independent lightweight work moving.

The wasm32 suite covers packaged runtime boot, `uname`, clean shutdown,
Worker scheduler handoff, spawn, private-memory snapshots, OPFS storage and
virtio-fs. It catches SAB/COOP/COEP/Worker/module-loading regressions that only
show up on a real browser engine. Site/service-worker integration checks are
separate checks rather than part of every engine's suite.

## C/C++ user-program runtime suites

Memory64 has separate Chromium and Firefox checks. Their historic `memory64`
names are retained, but success requires user-program completion, not a kernel
version banner:

```console
nix build .#checks.x86_64-linux.browser-tests-check-memory64-chromium -L
nix build .#checks.x86_64-linux.browser-tests-check-memory64-firefox -L
```

The equivalent wasm32 entry points use matching wasm32 kernels and programs:

```console
nix build .#checks.x86_64-linux.browser-tests-check-runtime-wasm32-chromium -L
nix build .#checks.x86_64-linux.browser-tests-check-runtime-wasm32-firefox -L
```

Both profiles use the default NOMMU kernel and two CPUs. The suite checks:

- Invalid CPU counts rejected before device configuration or kernel fetch.
- musl arguments/environment, allocation, anonymous mmap, partial munmap,
  rejected out-of-range fixed mappings, pthread/TLS and signals.
- C++ containers, exceptions/RAII, cross-thread exception lifetime, RTTI,
  thread-local cleanup and condition-variable handoff.
- SDK-built SQLite transactions, reopen, locking and rollback-journal recovery.
- SDK-built Unix/TCP/UDP socket operations and readiness/epoll behavior.
- SDK-built time64 timers and ready-fd waits.
- SDK-built pthread time64 deadlines, cancellation, broadcast and lock ownership.
- Kernel download failure followed by same-page recovery with a generic MIME type.

Each program must emit its complete user-console result and close the machine
successfully. Boot-console pass markers cannot substitute for user-program
completion. The exact-title JSON report gate rejects missing, skipped, retried,
unexpected or failed cases; adding a test does not itself establish a passing
browser result. Runtime setup and required titles are defined together in
`distro/npm/browser-tests.nix`.

These suites do not turn the high-level agent into a wasm64 agent, run the full
distribution test matrix, enable kernel softmmu or validate experimental EROFS
initialized-copy mappings. SQLite uses the current NOMMU profile (no WAL or
file mmap); process-exit recovery is not a browser crash or power-loss test.

## Native wasm64 agent bring-up

Independent Chromium and Firefox checks use the same minimal initramfs and six
runtime cases as `guest-agent-check-runtime-wasm64`. They cover ABI identity,
seek beyond 4 GiB, small-file truncate/stat, detached descriptors, native program
arguments/environment/cwd, binary standard streams, exit status, SIGTERM and
session process-group cleanup before reconnect. The shared TypeScript corpus is
bundled for the browser; its Node entry point is not shipped into the page.

```console
nix build .#checks.x86_64-linux.browser-tests-check-agent-wasm64-chromium -L
nix build .#checks.x86_64-linux.browser-tests-check-agent-wasm64-firefox -L
```

The browser test requires the exact six completed case names and machine closure.
Its report gate requires one successful test with no skips or retries. No engine
feature flags or unsupported-engine skips are used. This is an internal bring-up
fixture, not a public wasm64 image selector or a full distro boot: production root
discovery/pivot, mounts and networking remain outside this suite. A Node pass is
not evidence of a browser pass; the browser runs must be checked independently.

## Experimental EROFS copy lifecycle

Independent suites use the opt-in test kernel and the same C test/initramfs
and EROFS image as the Node `mmap-benchmark[-wasm64]-check-erofs` checks:

```console
nix build .#checks.x86_64-linux.browser-tests-check-erofs-wasm32-chromium -L
nix build .#checks.x86_64-linux.browser-tests-check-erofs-wasm32-firefox -L
nix build .#checks.x86_64-linux.browser-tests-check-erofs-wasm64-chromium -L
nix build .#checks.x86_64-linux.browser-tests-check-erofs-wasm64-firefox -L
```

Each check runs two independent boots: the copy-lifecycle scenario uses one
snapshot disk and one ordinary read-only disk; the read-error scenario uses
a deliberately damaged snapshot with an out-of-range data address and a file
with one valid page followed by one invalid page. Both boot four CPUs,
wait for the C program's pass/fail marker (not just a startup banner), record
the browser version and require machine shutdown. The program checks source
admission, content/zero tails, private callback clone, normal/fatal exit after
publication, concurrent copies, fd reuse and survival after source unmount.
The browser watchdog bounds execution; a delayed boot is closed if it completes
after the timeout. These suites do not enable test features in the ordinary
browser checks and do not prove safety of cancellation during actual device I/O.
Standard file mmap remains unsupported. The initial copy-only four-engine/profile
CI matrix passed after the harness formatting correction. The expanded matrix,
including real EIO, valid-prefix rollback and fstat metadata checks, is pending.
The same error C program also runs in separate Node
`mmap-benchmark[-wasm64]-check-erofs-errors` checks. Node and browser results are
recorded separately; a pass in one host does not establish coverage in the other.

The engine versions are pinned by nixpkgs and the matching Playwright driver.
No experimental browser feature flags are set by this suite; a pass does not
establish compatibility with every browser vendor's latest distribution.

## Headless graphics

The checks use nixpkgs' Mesa EGL vendor and DRI drivers with software
rendering. This keeps the browser environment independent of host GPU drivers
and works on GitHub's Ubuntu runners, inside the Nix sandbox, and on NixOS
without relying on `/run/opengl-driver`.
