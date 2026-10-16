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

`ChildProcess.close()` is idempotent. It terminates a still-tracked process,
settles buffered stdin, closes its standard descriptors, and waits for its
wait result and client process-slot release before returning. An aborted
`status` still rejects with the caller's reason; disposal does not replace that
result. A descriptor-close error is reported only after the wait has settled.
Disposal does not send another signal after a successful reap. This is not a
pidfd-based identity guarantee for every concurrent signal/reap race, nor a
promise to terminate an entire descendant process group.

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
