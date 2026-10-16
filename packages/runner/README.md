<!-- SPDX-License-Identifier: MIT -->

# Linux runner

The private Node runner boots the configured kernel package with console,
entropy, optional host directory shares, and file-backed block devices.
`wasm-linux-runner --disk path/to/root.img` attaches an existing image; repeat
`--disk` for additional devices. With no disk option the Nix wrapper supplies
its default root image. This does not select a different kernel ABI or create
an image automatically.

Each disk worker first attempts a read-write open and falls back to read-only
if that fails. Read-only devices omit write and flush callbacks. Read/write
loops complete short host I/O or stop at zero progress. Writable flush uses
`fsyncSync`; normal device close attempts fsync and then releases the file
descriptor even if fsync fails, preserving the sync error if close also fails.
Stat or device-installation failure releases the opened descriptor and retains
the initialization error. The packaged worker includes its storage helper.

Do not externally truncate or concurrently modify an attached image. These
operations are not an image lock, atomic transaction, clean Linux shutdown,
or proof of physical-media durability. A failed operation may have partially
changed the backing file. Keep important images backed up.

Lightweight host regressions can be run without booting Linux:

```sh
node --test packages/runner/tests/disk-storage.test.ts
```

They cover initialization cleanup, read-only fallback, short I/O, sync/close
failure ordering, and real-file reopen. The separate `runner-check-tests` Nix
check builds the packaged runner and runs the complete Linux integration tests
in public CI; host-only results do not establish that integration has passed.

The runner's own sources are MIT. Attached kernel and filesystem images retain
their individual component licenses; the runner does not relicense them.
