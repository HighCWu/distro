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
in a fresh Linux instance over the retained block bytes. The Node check has
passed. An additional browser case uses an actual OPFS disk, closes it after
sync, reloads the page, and reopens the same file for read-only verification
while blocking root-template fetches. The browser checks still require public
CI results. Neither path establishes crash recovery, WAL, physical durability,
or a complete wasm64 package repository.

## Linking applications with the installed library

The separate `dev` output contains `include/sqlite3.h`, `sqlite3ext.h`,
`lib/libsqlite3.a`, relocatable `lib/pkgconfig/sqlite3.pc`, and license texts.
Only `out` (the CLI and notices) is installed by default or put into the
application root; development files do not become runtime image contents.
The CLI itself links this same archive. `sqlite3ext.h` is the upstream header,
not a promise that loadable extensions are supported by this build.

```console
nix build .#sqlite3-wasm64.dev --out-link result-sqlite-dev -L
export WASM_PKG_CONFIG_PATH="$PWD/result-sqlite-dev/lib/pkgconfig"
export WASM_PKG_CONFIG_SYSROOT_DIR=/
wasm-linux-cc -pthread app.c $(wasm-linux-pkg-config --cflags --libs sqlite3) -o app.wasm
nix build .#checks.x86_64-linux.sqlite3-wasm64-check-development -L
```

Use the matching wasm64 SDK, not the default wasm32 compiler. The SDK's
pkg-config wrapper selects static dependency flags; `-lm` and `-pthread` are
part of the metadata. The development check copies the installed development
output into a new prefix and compiles the existing SDK SQLite consumer using
only that prefix's installed headers/archive, not SQLite source files. It then
boots the consumer under wasm64 Linux, requiring its complete runtime marker
(including transactions, locks, and hot rollback-journal recovery). Its results
must still be checked in public CI. The lightweight metadata regression verifies
prefix relocation, static flags, and no host fallback after removing the `.pc`;
it does not validate Wasm archive contents or target execution.

The first application-root CI built the CLI and verified its Wasm memory ABI,
but Nix rejected an embedded reference to the SQLite source store path before
Linux runtime tests began. The recipe now copies the unchanged compilation
inputs into the build directory and compiles relative source paths for both
the archive and shell. The empty `allowedReferences` gate remains enabled;
the corrected application-root Node build and runtime have passed. The separate
installed-library consumer and browser checks still require CI verification.

SQLite's upstream public-domain declaration is retained in the installed
`share/licenses/sqlite3/sqlite3.h`. Static musl and compiler-rt license texts are
also installed; those components retain their own terms. The MIT license on the
build recipe does not relicense upstream or linked code. Included notices are
not a complete dependency inventory or release-compliance certification.
