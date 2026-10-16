# `@lowland/guest`

`@lowland/guest` is the Lowland guest-agent integration. It contributes its
private boot filesystem and vsock transport to an `@lowland/kernel` machine and
exposes processes, files, mounts, and networking through the returned agent.

The default packaged agent image and default startup path currently use wasm32.
A custom native wasm64 agent image can be selected explicitly, as described
below; this does not publish a full wasm64 agent/system distribution.
Kernel/SDK checks alone do not establish support for that
image or system root. Keep these assets matched when booting;
do not combine the default agent image with a wasm64 kernel merely because
both packages expose the same JavaScript API.

## Installation

```sh
npm install @lowland/kernel @lowland/guest
```

## Usage

```js
import { blockDevice, bootMachine } from "@lowland/kernel";
import { guestAgent } from "@lowland/guest";

const rootfs = new Uint8Array(
  await fetch("/rootfs.erofs").then((response) => response.arrayBuffer()),
);
const root = blockDevice({
  capacity: rootfs.byteLength,
  read(offset, target) {
    const source = rootfs.subarray(offset, offset + target.byteLength);
    target.set(source);
    return source.byteLength;
  },
});

const guest = guestAgent();
await using machine = await bootMachine({
  cpus: 1,
  plugins: [root, guest],
});

const result = await guest.run(["uname", "-a"]);
console.log(new TextDecoder().decode(result.stdout));
```

`exec()` returns a live `ChildProcess` with streaming standard I/O. `run()`
collects its status, stdout, and stderr and is convenient for bounded commands.
Both methods accept an argv array without shell parsing.

`run()` owns the child it creates: it sends stdin EOF, collects both outputs
concurrently, and awaits disposal on success or failure. Nonzero exit status
still returns a `RunResult`. An execution/transport/abort failure is rethrown
after cleanup; if cleanup also fails, an `AggregateError` contains the primary
failure followed by the cleanup error, with the primary failure as `cause`.
If only cleanup fails, that error is reported directly. Output collection is
still in-memory; use streaming `exec()` for unbounded output.

`ChildProcess.close()` is idempotent. It terminates a still-tracked process,
settles buffered stdin, closes its standard descriptors, and waits for its
wait result and client process-slot release before returning. An aborted
`status` still rejects with the caller's reason; disposal does not replace that
result. A descriptor-close error is reported only after the wait has settled.
Disposal does not send another signal after a successful reap. This is not a
pidfd-based identity guarantee for every concurrent signal/reap race, nor a
promise to terminate an entire descendant process group.

The public `ChildProcess.kill()` also rejects with `SystemError("ESRCH")`
without dispatching a signal after this handle has confirmed a successful
reap, including when its `status` rejects because the caller aborted it.
Signalling a still-live handle retains the normal signal/status semantics.
This does not prove that a process is still alive before every queued syscall:
exit and PID reuse can still race a request made before reap was observed.
Use the child capability while it is live, not its numeric PID as a permanent
identity; the SDK does not currently provide pidfd-backed signalling.
Six added dual-width mock-protocol cases (14 lifecycle cases total) verify
expired-handle rejection without a syscall, live signalling and aborted-reap
handling. Real wasm32 integration and wasm64 public-userland checks also assert
the exposed `ESRCH` behavior. The wasm64 Node userland run at `50c3439` has
passed all six tests without failures, cancellations or skips. The wasm32
integration at the same revision passed all 274 tests, including reaped-handle
rejection and buffered-input/fd-reuse ordering, with zero failures/cancellations/
skips. Neither result validates later stdin, copy or streaming revisions.

Descriptor owners become invalid when close begins, including when Linux later
reports a close error. Further operations reject with `EBADF` without sending
the old fd number. An operation waiting for a syscall lane rechecks ownership
before writing its request; local rejection leaves the session usable. Output
already buffered before process disposal may still be consumed, but further
pulls cannot issue reads through the closed owner. This does not cancel an
already dispatched syscall or make separately constructed owners of the same
numeric fd safe. Eight added dual-width host cases cover close errors, queued
operations, continued session use and stale process outputs; 62 related host
tests and TypeScript checks pass. These are not native fd-reuse stress tests.

Process disposal also errors an unfinished stdin immediately: outstanding
writers observe `EPIPE` from `write()` and `closed`, rather than accepting data
that the stopped host pump would discard. An already observed pump error is
preserved instead; stdin EOF completed before disposal remains successful.
Buffered write success is not a delivery acknowledgement, and disposal may
discard buffered input while still waiting for an injected write to settle.
Ten additional dual-width host cases cover disposal before/after reap, abort
reasons, prior pump errors and normal EOF (72 related host tests pass).
Native wasm32 and shared wasm64 public-userland assertions are included;
the Chromium run at `fdde5c7` passed all six internal scenarios and its exact
outer case with zero skips/retries. This does not validate later copy, NUL or
spawn preflight revisions, and wasm32 remains separate from host validation.

`fs.copyFile()` validates the source and destination using `fstat` on both
opened descriptors before truncating the destination. Identical device/inode
pairs reject with `EINVAL`, including symlink or hard-link aliases introduced
between pathname lookup and open. Identity stays at kernel integer width;
large inode numbers are not rounded into JavaScript numbers. Both descriptors
are close-on-exec and are disposed on validation errors. This is not an atomic
copy, immutable snapshot, path-confinement guarantee or rollback on I/O failure;
a newly created destination can remain after a failed operation. Eight added
dual-width protocol cases cover stale paths, exact identity, short writes and
cleanup, with 85 related host tests passing. Native ordinary-copy and symlink
alias assertions have passed in Node at `f973002` and Firefox at `09e1ea8`.
Those native cases use stable aliases, not a real rename-race stress test.

Linux C-string arguments (paths, symlink targets, mount source/type/options)
reject embedded NUL with `TypeError` before the syscall is sent. They are not
silently truncated to another path or option prefix. Literal Unicode, spaces,
newlines and shell metacharacters remain UTF-8 data, not shell commands. This
does not normalize paths, confine access or make multi-operation filesystem
methods transactional. Dual-width protocol tests cover 16 argument positions
with leading/interior/trailing NUL and continued valid I/O (87 related host
tests pass). Native write/remove/rename preservation assertions are included;
they passed in Node at `f973002` and Firefox at `09e1ea8`, separately from host
validation. Neither result includes later streaming or binary-input changes.

Process admission is capped at eight live SDK children so blocked process I/O
does not consume every syscall lane. An `exec()` waiting for capacity is
abortable: it rejects with the original signal reason, removes its waiter,
and does not spawn later when another child exits. Admission rechecks the
signal after a grant and returns an unused slot if cancellation won that race.
Active children still require normal termination and reaping; cancellation of
a queued request does not cancel them or provide process-group termination.

The v3/v4 spawn serializer accepts at most 256 argv strings (including the
executable), 256 environment entries (including defaults), and 4096 UTF-8 bytes
per argv entry, cwd or complete `NAME=value` entry. Embedded NUL and malformed
environment entries reject with `EINVAL`, as does exceeding those bounds,
before acquiring a wire lane. This prevents a huge request from triggering
the executor's 4 MiB framing-disconnect rule. High-level empty argv retains its
existing `TypeError`. These are current agent protocol limits, not universal
Linux limits or a promise the kernel can execute every wire-valid request;
native exec can still return errors such as `E2BIG`. Four added dual-width host
cases verify rejection and exact byte/count boundaries (91 related host tests
pass); CI also checks that SDK constants match the native parser and the
largest permitted body fits its frame. Updated native oversized-input and
subsequent-execution assertions have passed in Node at `f973002`: seven tests,
zero failures/cancellations/skips. This does not validate later streaming or
example binary-input revisions, nor a browser run of the spawn preflight change.

For larger inputs, `exec(argv, { stdinMode: "streaming", signal })` makes each
stdin write wait for native pipe acceptance and propagates that write's error.
`pipeTo()` or sequential awaited writes then apply backpressure instead of
building the SDK's compatibility-mode background input queue. Drain stdout
and stderr concurrently, for example with application-provided byte streams:

```ts
await using child = await agent.exec(["cat"], {
  stdinMode: "streaming",
  signal: AbortSignal.timeout(30_000),
});
const [, , , status] = await Promise.all([
  input.pipeTo(child.stdin),
  child.stdout.pipeTo(output),
  child.stderr.pipeTo(diagnostics),
  child.status,
]);
```

Here `input` is a `ReadableStream<Uint8Array>` (such as `file.stream()`), and
`output`/`diagnostics` are writable byte sinks supplied by the embedder. Waiting
for all input before reading outputs can deadlock. Use the exec signal or
`child.close()` to interrupt a blocked injected write; Web Streams can defer
`writer.abort()` until its pending sink write finishes. No hard memory quota
is implied: chunk sizes and upstream queues still matter, and ignoring write
promises can queue arbitrarily much data. The default `"buffered"` mode retains
its earlier feed-input-first behavior. Both modes preserve disposal/reap order.
Thirteen additional host cases cover mode selection, blocked writes/producer,
snapshots, errors and disposal (104 related tests pass). Native dual-mode binary
pipeline and wasm32 tests are updated but still require their target results.

The plugin boots its private EROFS using the GPT partition label
`LOWLAND_AGENT`, so its position among block-device plugins is irrelevant. The
agent then requires exactly one attached EROFS or ext4 filesystem labeled
`LOWLAND_ROOT`, pivots into it, and unmounts its private boot filesystem.
Missing and duplicate system roots fail `bootMachine()` through the plugin
readiness hook.

### Explicit custom agent images

`guestAgent()` preserves the packaged wasm32 image and legacy v3 handshake.
For native bring-up, supply a matching GPT-wrapped agent image and ABI:

```js
const response = await fetch("/native-agent-wasm64.img");
if (!response.ok) throw new Error(`agent download failed: ${response.status}`);
const guest = guestAgent({
  abi: "wasm64",
  image: new Uint8Array(await response.arrayBuffer()),
});
```

This requires a matching wasm64 build of `@lowland/kernel` and a separate
wasm64 `LOWLAND_ROOT` system disk, not the default wasm32 package/root image.
Do not pass an overriding `initcpio` that bypasses the agent boot disk.
The plugin still contributes its boot arguments, vsock and readiness hook;
file/process capabilities use the explicit v4 ABI without automatic fallback.
Image bytes are copied when the agent is created, including only the supplied
view. Custom images require an explicit ABI and a positive whole number of
512-byte sectors. Those shape checks do not validate the executable or prove
that its ABI matches the selected kernel: boot/handshake validation remains
required. Selecting wasm64 without a custom image fails before boot.

The native artifact is built from `guest-agent.nativeWasm64.bootDisk` in the
source flake. Its end-to-end public API check is
`guest-agent-check-public-wasm64`. These are bring-up paths, not a claim that
all system packages or browsers support wasm64.

For a system root without the test executable or test markers, the source
flake exposes `guest-agent.nativeWasm64.rootfs`. It installs only the matching
wasm64 BusyBox package (including its license texts) and minimal filesystem
configuration, with the `LOWLAND_ROOT` label and the private-network resolver
address. It does not use the default wasm32 package repository.

The root includes `/etc/passwd` and `/etc/group` for the existing UID/GID 0
identity, and `/etc/mtab` links to `/proc/mounts`. These support ordinary user
name and mount-table lookups, not a login service, credentials, or multi-user
isolation. The minimal-root check verifies `id -un` and reading the mount-table
link in the running system; target execution still requires a passing CI run.

Build heavy artifacts in public CI; these explicit source-flake targets select
the matching boot disk, system root and kernel package:

```sh
nix build .#legacyPackages.x86_64-linux.guest-agent.nativeWasm64.bootDisk
nix build .#legacyPackages.x86_64-linux.guest-agent.nativeWasm64.rootfs
nix build .#kernel-wasm64
nix build .#checks.x86_64-linux.guest-agent-check-minimal-root-wasm64
```

Attach the root bytes with `blockDevice()` as in the usage example and supply
the boot disk to `guestAgent({ abi: "wasm64", image })`. A separate explicit
Node check verifies this actual minimal root rather than substituting the
fixture root. Adding the check does not establish it has passed; browser,
full shell, networking and a larger package set still need their own results.
The same four-case minimal-root corpus is also wired into explicit
`browser-tests-check-agent-minimal-root-wasm64-chromium` and
`browser-tests-check-agent-minimal-root-wasm64-firefox` checks. They verify the
real system root, not the separate public API fixture images, and require
the exact case list, machine closure, and a report without skips or retries.
The default npm assets remain wasm32. This experimental root is not a complete
distribution release: BusyBox remains GPL-2.0-only, and its included license
texts do not replace corresponding-source delivery or a full release inventory.

An opt-in writable ext4 variant is available separately; the default root stays
EROFS and the default npm assets stay wasm32:

```sh
nix build .#legacyPackages.x86_64-linux.guest-agent.nativeWasm64.rootfsExt4
nix build .#checks.x86_64-linux.guest-agent-check-persistent-root-wasm64
```

Use the matching native boot disk and a writable `blockDevice()` whose `read`
and `write` callbacks access the same retained bytes. `write` returns the number
of bytes written; `flush` must complete the backing store's synchronization
contract, rather than merely schedule it. The 64 MiB ext4 image mounts read-write
without a temporary overlay. Applications must retain their backing storage
themselves; closing a machine does not export or persist it automatically.

The shared Node/browser check writes a binary file, syncs it, renames it, changes
permissions, and runs `/bin/sync`, requiring block writes and flush callbacks.
After closing that machine, a fresh instance verifies the retained block bytes,
file size/mode, and native `cat` output. This checks in-memory block retention
across instances, not OPFS, browser reloads, physical durability, or clean system
shutdown. Wiring the check is not evidence of runtime success.

The browser profile additionally checks reopening that ext4 image through the
existing OPFS disk worker after page reload, with no template fetch on readback.
See the browser-tests README for its distinct scope and required runtime checks.

For a separate application root with the installed native SQLite CLI, select
`guest-agent.nativeWasm64.rootfsSqliteExt4`. Its dedicated check is
`guest-agent-check-sqlite-root-wasm64`; it verifies transactions, rollback,
sync and exact database readback across fresh instances with retained blocks.
The default minimal roots are unchanged. This profile is not an OPFS or WAL
test; see `distro/sqlite3/README.md` for package flags and licensing boundaries.

Pass `"lowland.root.overlay=tmpfs"` as a kernel argument to mount the system
image read-only beneath a temporary writable OverlayFS:

```js
const guest = guestAgent();
await using machine = await bootMachine({
  cpus: 1,
  args: ["lowland.root.overlay=tmpfs"],
  plugins: [guest, root],
});
```

## Networking

Networking is another composable guest integration:

```js
import { createNetwork } from "@lowland/guest";

const guest = guestAgent();
const network = createNetwork({ connectTcp, resolveDns });
const attachment = network.attach(guest);

await using machine = await bootMachine({
  cpus: 1,
  plugins: [root, guest, attachment],
});

console.log(attachment.address);
```

The attachment contributes the virtio NIC and configures it after the agent is
ready. Each agent supports one network attachment; attach multiple agents to
the same network to put them on one private IPv4 subnet.

## Host directory adapters

`@lowland/guest/node` provides `NodeFS`, and
`@lowland/guest/browser` provides `BrowserFS`. Adapt them with the kernel's
`fileSystemDevice()` and mount the resulting virtio-fs device through the
agent:

```js
import { fileSystemDevice } from "@lowland/kernel";
import { NodeFS } from "@lowland/guest/node";

const shared = fileSystemDevice(new NodeFS("/srv/guest-share"), {
  tag: "host",
  cache: false,
});
const guest = guestAgent();
await using machine = await bootMachine({
  cpus: 1,
  plugins: [root, guest, shared],
});
await guest.fs.mkdir("/tmp/host");
await guest.mount("host", "/tmp/host", { type: "virtiofs" });
```

Pass `{ readOnly: true }` to `NodeFS` when read-only access is part of the trust
boundary. A read-only guest mount alone does not prevent writes through raw
filesystem requests. The Node adapter confines paths beneath its configured
root and does not follow final symlinks, but portable Node lacks the
descriptor-relative operations needed to make that confinement race-free
against an unrelated host process restructuring the directory. Use an OS
sandbox or native helper when that stronger boundary is required.

Nodes belong to one adapter instance, and open handles belong to their original
node. Cross-adapter nodes and mismatched handles are rejected before descriptor
operations, including metadata, synchronization and close. An already-open Node
file descriptor remains usable after unlink or replacement rename; validating
ownership does not retarget it to a new file at the same pathname. These checks
prevent adapter mix-ups, not hostile host namespace races.

Node reads and writes validate the complete offset/length range before buffer
allocation or host I/O. Negative, fractional, non-finite or unsafe-integer ranges
return EINVAL. Valid reads beyond EOF remain short reads; these numeric checks
are not a memory quota or a guarantee that every representable request can be
allocated.

Timestamp metadata normalizes pre-epoch values to nonnegative nanosecond
fractions. Updates use numeric-second strings rather than Date objects, avoiding
millisecond truncation and Node's special handling of negative numeric times.
The host API still has floating-point/platform precision limits: preserving an
omitted timestamp requires reading and rewriting it, not an atomic UTIME_OMIT.

`BrowserFS` accepts OPFS and user-selected `FileSystemDirectoryHandle` values.
The browser API has no Unix inode metadata or atomic portable rename, so the
adapter synthesizes metadata and implements rename as copy-then-remove. A
failed rename can leave a partial destination or both names. Use `cache: false`
for directories modified outside the guest; this disables metadata and name
caching, but not the guest's data page cache.

## License

The TypeScript and JavaScript sources are available under the MIT license. The
published agent image also contains GPL-2.0-only BusyBox and MIT-licensed musl.
