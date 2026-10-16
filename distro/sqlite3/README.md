<!-- SPDX-License-Identifier: MIT -->

# SQLite userland

The default `sqlite3` package still targets the wasm32 distribution and includes
readline/ncurses. The explicit `sqlite3-wasm64` package builds the upstream CLI
from the same pinned amalgamation and shell sources with `sdk-wasm64`; it does
not link wasm32 distribution libraries. It provides `/bin/sqlite3`, without
readline, loadable extensions, WAL, or database mmap. Normal Unix VFS file I/O,
DELETE rollback journals, threading, and synchronous writes remain available.
Actual target behavior must be established by CI, not inferred from flags.

```console
nix build .#sqlite3-wasm64 -L
nix build .#legacyPackages.x86_64-linux.guest-agent.nativeWasm64.rootfsSqliteExt4 -L
nix build .#checks.x86_64-linux.guest-agent-check-sqlite-root-wasm64 -L
```

Run heavy builds in public CI. The package checks the final CLI's shared wasm64
`env.memory` import and 16 GiB declared ceiling. That ceiling is not a claim of
available runtime RAM. The dedicated 64 MiB ext4 application root installs this
CLI with matching BusyBox, leaving the default minimal EROFS/ext4 roots unchanged.
Its shared Node/Chromium/Firefox checks commit a 64-bit integer and binary BLOB,
roll back an update, sync, close Linux, then verify integrity and exact fields
in a fresh Linux instance over the retained block bytes. This is not OPFS,
crash recovery, WAL, or a complete wasm64 package repository.

SQLite's upstream public-domain declaration is retained in the installed
`share/licenses/sqlite3/sqlite3.h`. Static musl and compiler-rt license texts are
also installed; those components retain their own terms. The MIT license on the
build recipe does not relicense upstream or linked code. Included notices are
not a complete dependency inventory or release-compliance certification.
