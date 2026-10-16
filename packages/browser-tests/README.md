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

Independent Chromium and Firefox checks use the same minimal initramfs and seven
runtime cases as `guest-agent-check-runtime-wasm64`. They cover ABI identity,
seek beyond 4 GiB, small-file truncate/stat, detached descriptors, native program
arguments/environment/cwd, binary standard streams, exit status, SIGTERM and
session process-group cleanup before reconnect. The shared TypeScript corpus is
bundled for the browser; its Node entry point is not shipped into the page.

```console
nix build .#checks.x86_64-linux.browser-tests-check-agent-wasm64-chromium -L
nix build .#checks.x86_64-linux.browser-tests-check-agent-wasm64-firefox -L
```

The browser test requires the exact seven completed case names and machine closure.
The final case uses the internal high-level client with an explicit wasm64 ABI:
file read/write/stat/truncate/remove, seek beyond 4 GiB, and a native process's
exit status. These are required runtime assertions, not build-only checks.
Its report gate requires one successful test with no skips or retries. No engine
feature flags or unsupported-engine skips are used. This is an internal bring-up
fixture, not a public wasm64 image selector or a full distro boot: production root
discovery/pivot, mounts and networking remain outside this suite. A Node pass is
not evidence of a browser pass; the browser runs must be checked independently.

### Production entry and root pivot

Separate checks replace the fixture PID 1 with the real native wasm64 agent
entry point and attach its matching `LOWLAND_ROOT` EROFS image:

```console
nix build .#checks.x86_64-linux.browser-tests-check-agent-production-wasm64-chromium -L
nix build .#checks.x86_64-linux.browser-tests-check-agent-production-wasm64-firefox -L
```

They reuse the Node production check's initramfs and root image, not its result.
The shared corpus requires the root marker, EROFS read-only root mount,
proc/sys/devpts directories and detached old initramfs in addition to all seven
file/process cases. The report requires the exact eight completed case names,
machine closure, one successful test, no skips and no retries. Asset download
failures are errors; there is no fallback to the fixture or another ABI.
The fixture root includes the native test program, not a full distribution or
system init. Passing Node production tests alone does not establish browser
production support.

Session admission tracing is disabled in the shared corpus by default. For a
focused diagnostic, the browser entry accepts
`runNativeAgent({ productionRoot: true, traceSessions: true })`; the explicit
Node runtime wrapper accepts `AGENT_WASM64_TRACE=1`. Compare traced and untraced
results separately: diagnostic output can affect scheduling and is not a fix
for an intermittent handshake timeout.

### Fixture-free minimal system root

Independent checks boot `guest-agent.nativeWasm64.rootfs` with the native boot
disk using only public `guestAgent({ abi: "wasm64", image })` selection. They
share four cases with Node: root identity and mount metadata, installed license
texts and absence of runtime fixtures, exact binary BusyBox output, and basic
installed shell execution. The browser result requires all four case names,
machine closure, and an exact successful report without skips or retries.

```console
nix build .#checks.x86_64-linux.browser-tests-check-agent-minimal-root-wasm64-chromium -L
nix build .#checks.x86_64-linux.browser-tests-check-agent-minimal-root-wasm64-firefox -L
```

Run heavy builds in public CI. Wiring the checks does not establish they have
passed, certify the richer shell/network profiles, or complete distribution
release compliance. No test executable is installed into this system root.

### Opt-in writable ext4 system root

The persistent-root profile uses `guest-agent.nativeWasm64.rootfsExt4` and the
matching native boot disk. Node and both browsers share two cases: binary file
write/sync/rename/chmod with observed block writes and flushes, then exact data
and metadata readback in a fresh Linux instance after the first is closed.
The browser gate requires both case names, closure, and zero skips/retries.

```console
nix build .#checks.x86_64-linux.guest-agent-check-persistent-root-wasm64 -L
nix build .#checks.x86_64-linux.browser-tests-check-agent-persistent-root-wasm64-chromium -L
nix build .#checks.x86_64-linux.browser-tests-check-agent-persistent-root-wasm64-firefox -L
```

An additional browser case initializes a uniquely named OPFS image, opens the
existing synchronous-access disk worker, and runs the same write/sync checks.
After device closure and a page reload, a new worker reopens that existing image
without a capacity override or a template download and verifies data and mode.
Both browser cases must pass without skips or retries, including on Firefox.
The worker is bundled against the matching wasm64 kernel package; this does not
build or depend on the entire site.

Run heavy builds in public CI. The Node and first browser case retain only host
block bytes; the additional case checks normal synchronized OPFS page reload,
not a browser process restart, eviction, physical durability, crash recovery,
or graceful Linux shutdown. The default EROFS profile is unchanged. These newly
wired checks still require actual runtime results. Six mock-host regressions
check initialization, readback without replacement, and failure cleanup; they
do not substitute for actual OPFS or Linux execution.

### Native SQLite application root

The explicit SQLite profile installs `sqlite3-wasm64` in a separate ext4 root,
not the minimal default root. Its two shared Node/browser cases execute the
installed upstream CLI directly: DELETE/FULL transaction commit and rollback,
then fresh-instance read-only integrity, row count, exact 64-bit integer and
BLOB verification. Writes and metadata are synchronized before closure.

```console
nix build .#checks.x86_64-linux.guest-agent-check-sqlite-root-wasm64 -L
nix build .#checks.x86_64-linux.browser-tests-check-agent-sqlite-root-wasm64-chromium -L
nix build .#checks.x86_64-linux.browser-tests-check-agent-sqlite-root-wasm64-firefox -L
```

The browser gate requires both internal case names, machine closure, and the
exact successful outer report without skips/retries. A second browser case
creates a uniquely named OPFS disk from the root template, commits and syncs
through the installed CLI, closes the machine and disk, reloads the page, then
reopens the same OPFS file for read-only database verification. Template fetches
are blocked during readback, and the test removes only its own disk afterward.
The matching memory64 disk worker uses the production startup helper without
capacity reinitialization, so reopening does not truncate the filesystem.

The Node application-root check and original retained-memory Firefox case have
passed; the additional OPFS case still requires public CI verification.
These checks do not establish
browser process restart, crash recovery, WAL, or physical durability. Four mock
host orchestration regressions cover existing-byte readback, input validation,
template commit ordering, and error cleanup; native host SQLite command tests
reject missing, corrupt, or wrong-field databases. Neither proves Wasm or OPFS
execution. Run heavy builds in public CI.

### Standalone wasm64 embedding example

The `wasm64-example` package is a standalone browser application using native
wasm64 boot/root assets, not runtime fixtures. Its UI checks are explicit:

```console
nix build .#checks.x86_64-linux.browser-tests-check-wasm64-example-chromium -L
nix build .#checks.x86_64-linux.browser-tests-check-wasm64-example-firefox -L
```

The shared scenario clicks the real page controls to boot, run `uname`, perform
an exact UTF-8 file round-trip, stop, restart with a fresh disk, observe native
`cat` fail for the old file, and run another successful command. The strict
report requires the exact outer case without skips/retries. Its development
server never builds assets on demand. Heavy builds run in public CI; these new
checks still need target results. This is intentionally an in-memory example,
not a persistent installation or OPFS test. See `apps/wasm64-example/README.md`.

### Public plugin and GPT boot disk

The public API has separate checks, using the same assertions as
`guest-agent-check-public-wasm64`:

```console
nix build .#checks.x86_64-linux.browser-tests-check-agent-public-wasm64-chromium -L
nix build .#checks.x86_64-linux.browser-tests-check-agent-public-wasm64-firefox -L
```

They create `guestAgent({ abi: "wasm64", image })`, attach a separate system root
before the GPT agent disk, and pass neither an external initramfs nor manual boot
arguments. Assets come from the native disk check, not from its successful result.
The three required cases cover root pivot and read-only root, public file APIs
including seek beyond 4 GiB, and `run()` exit status plus argv/env/cwd forwarding.
The result must contain exactly these completed cases and machine closure; the
report gate requires one successful test with no skips or retries. Downloads
must succeed; neither another ABI nor the internal client is a fallback.

The shared suite externalizes the kernel and its plugin entry point. The import
map must resolve both to the same installed kernel package, preserving the
plugin identity symbol. These checks do not change default wasm32 image selection
or establish full distribution support. Their browser results must be verified
independently of the earlier successful Node public-plugin check.

### Native shell through the public plugin

An additional profile installs matching wasm64 BusyBox in the system root,
without changing the default wasm32 distribution or the minimal public profile:

```console
nix build .#checks.x86_64-linux.guest-agent-check-public-userland-wasm64 -L
nix build .#checks.x86_64-linux.browser-tests-check-agent-public-userland-wasm64-chromium -L
nix build .#checks.x86_64-linux.browser-tests-check-agent-public-userland-wasm64-firefox -L
```

The Node and browser checks share the same five-case corpus and boot disk/root
assets, not another check's successful result. In addition to the three public
API cases, `run()` starts `/bin/sh` and requires correct cwd, quoted argv and
environment, pipelines, command substitution, file operations, nonzero child
status and background-child wait. The exact output, zero stderr, successful
status, five completed cases and machine closure are required. The additional
`exec()` case streams 256 KiB + 17 binary bytes (including NULs) through a native
`tee | cat` pipeline, drains stdout and stderr concurrently with stdin, and
requires byte-for-byte equality on both outputs, success and temporary-file
removal. This checks real userland pipes through the public streaming API, not
just a single-purpose C fixture or a small collected text command. Missing shell
assets or execution failures are errors, not fallback to the minimal C program.
No external initramfs, manual boot arguments or session trace flag is supplied.

The pinned hush resets `$?` while skipping a failed condition's `then` branch.
The corpus therefore captures child status immediately with
`command || status=$?`, rather than in `else`. The expected status remains 7;
host regression tests also require successful children and status 23 to fail
that assertion. This accommodates upstream hush behavior, not a kernel or
libc wait-status fix, and does not establish full POSIX shell conformance.
The shell lifecycle case also waits for an atomically renamed readiness marker
from a real running command, aborts `run()`, requires the original abort reason,
and runs another command successfully after cleanup. This is not merely an
already-aborted signal rejected before spawning.
It additionally fills all eight SDK process slots with real `sleep` commands,
cancels the ninth `exec` before releasing them, requires prompt rejection with
the original reason, disposes the running children and successfully starts a
replacement. The same runtime check is included in the wasm32 process corpus;
host-only tests cover FIFO preservation and cancellation after a grant, but do
not establish target runtime success.

The pinned NOMMU BusyBox uses hush, not a fully POSIX-compatible shell. In
particular it supports `set -e` but not `set -u`/nounset. The shared command
fixtures use errexit and explicit value assertions; they do not claim nounset
support. Their host-only syntax and binary-pipeline checks do not replace the
Node and browser Linux/Wasm executions:

```console
node --test packages/linux-guest/tests/agent-wasm64-userland-commands.test.ts
```

An independent public-network profile additionally attaches the public
`createNetwork()` plugin before the agent, configures the native interface,
and reaches a BusyBox `httpd` process through `attachment.connect()`. It waits
for the exact port in `/proc/net/tcp` to reach LISTEN, requires HTTP 200 with
the exact body, terminates/reaps the server, checks empty process output, and
closes the connection, network and machine. Its six completed cases are
required by the browser gate; userland-only checks still require five.

```console
nix build .#checks.x86_64-linux.guest-agent-check-public-network-wasm64 -L
nix build .#checks.x86_64-linux.browser-tests-check-agent-public-network-wasm64-chromium -L
nix build .#checks.x86_64-linux.browser-tests-check-agent-public-network-wasm64-firefox -L
node --test packages/linux-guest/tests/agent-wasm64-public-network.test.ts
```

This uses the same native userland assets, not a successful result from another
check. Outbound adapters and DNS are deliberately unavailable: this is private
host-to-instance Ethernet/TCP validation, not browser raw sockets, Internet
access, DNS, proxy, TLS, or UDP certification. Exposing these checks does not
mean their actual Linux/Wasm execution has passed. Run heavy builds in public CI.

BusyBox remains GPL-2.0-only and its package architecture is wasm64. These test
images are not a full distribution release or a change to users' software
licenses; any redistributed image must satisfy its components' license and
corresponding-source obligations. Exposing these checks is not itself evidence
that their browser runs have passed.

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
