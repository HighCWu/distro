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

## License

The TypeScript and JavaScript sources are available under the MIT license. The published package also contains `vmlinux.wasm`, which remains `GPL-2.0-only WITH Linux-syscall-note`.

Nix-built packages include `linux-build/` with that kernel's final configuration,
original Linux license texts, build input identities and checksums. Verify from
the package root with `sha256sum --check linux-build/SHA256SUMS`. This material
is not a complete corresponding-source archive; distributors still need to
provide the exact applicable sources and build instructions. The syscall
exception does not relicense kernel implementation code as MIT.
