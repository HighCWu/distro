<!-- SPDX-License-Identifier: MIT -->

# `@lowland/kernel`

`@lowland/kernel` runs a Linux kernel compiled to WebAssembly and exposes low-level machine and virtio device APIs.

## Installation

```sh
npm install @lowland/kernel
```

## Documentation

See [linux.tombl.dev](https://linux.tombl.dev/getting-started/).

## API

See the [`@lowland/kernel` reference](https://linux.tombl.dev/reference/kernel/).

### Cancelling worker-device startup

`workerDevice(endpoint, { signal })` accepts an optional AbortSignal while
waiting for the endpoint's ready message. A pre-aborted signal rejects without
starting the port or registering startup listeners. Aborting a pending wait
removes those listeners and preserves the exact abort reason. After readiness,
the signal is detached: aborting it does not close the returned device.

```js
const worker = new Worker("./disk-worker.js", { type: "module" });
try {
  const device = await workerDevice(worker, { signal: AbortSignal.timeout(30_000) });
  // Attach device to a machine; keep worker alive until device.closed settles.
} catch (error) {
  worker.terminate(); // Endpoint ownership remains with the caller.
  throw error;
}
```

Supply any required worker configuration using its protocol before awaiting
readiness. The timeout does not revoke configuration messages already sent,
roll back disk initialization, terminate a Worker, or guarantee resource
cleanup. On cancellation, the endpoint remains the caller's responsibility.
Calls without options retain their existing unbounded readiness wait.

## License

The TypeScript and JavaScript sources are available under the MIT license. The published package also contains `vmlinux.wasm`, which remains `GPL-2.0-only WITH Linux-syscall-note`.

Nix-built packages include `linux-build/` with that kernel's final configuration,
original Linux license texts, build input identities and checksums. Verify from
the package root with `sha256sum --check linux-build/SHA256SUMS`. This material
is not a complete corresponding-source archive; distributors still need to
provide the exact applicable sources and build instructions. The syscall
exception does not relicense kernel implementation code as MIT.
