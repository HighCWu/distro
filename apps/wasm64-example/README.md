<!-- SPDX-License-Identifier: MIT -->

# Standalone Linux wasm64 embedding example

This is a small application using the public kernel and agent APIs, not a
terminal distribution or test fixture. It bundles a matching wasm64 kernel,
native agent boot disk and minimal BusyBox ext4 root. The page starts/stops
Linux, runs native `uname`, writes bounded UTF-8 text through the file API and
reads it using native `cat`. No shell interpolation or arbitrary command input
is required by the example.

Build heavy assets in public CI:

```console
nix build .#wasm64-example --out-link result-wasm64-example -L
node result-wasm64-example/server.mjs
```

The built directory includes this README, the development server, and an
offline integrity checker. Copy the entire directory, including `node_modules`,
to a normal filesystem directory without installing Nix there, then run:

```console
node integrity.mjs
node server.mjs
```

Use a current Node.js release supporting ES modules. `integrity.mjs` reads the
adjacent `checksums.json` and checks SHA-256, sizes and the complete file
inventory, including the kernel, both disk images, scripts and notices. It
rejects missing, extra or changed files and payload symlinks, and exits nonzero
on failure. The build generates and checks the manifest after assembling the
package. You may also specify `node integrity.mjs --check /path/to/bundle`.
Do not regenerate the manifest to conceal a failed check. It detects accidental
damage or mixed payloads, not authenticity: an attacker able to replace both
the manifest and files can forge a matching set. Keep a trusted original;
no signatures, secure update mechanism or full license compliance are implied.
This is a static-payload check, not Linux execution or SDK relocatability.

Open the printed localhost URL. The server binds only to `127.0.0.1`, chooses
an available port (override with `PORT`), and serves files beside its script.
It supplies COOP/COEP and Wasm MIME headers. It never builds missing assets;
running it from the unbuilt source folder cannot boot Linux. You may instead
host the built directory on HTTPS with equivalent isolation headers, preserving
the import-map paths at the origin root. The development server is not a
general-purpose production server and does not handle HTTP range requests.

Every start downloads a fresh root image into host memory. Writes disappear
after stop, reload or failure: the no-op block flush only acknowledges the
in-memory backing, not durable storage. The page explicitly says this; it does
not silently fall back from OPFS. The 64 MiB image, kernel and per-process
memories consume additional browser resources. Memory64 and shared-memory
browser support are required; there is no wasm32 fallback or transpiler here.
Runtime errors remain visible and are not converted to compatibility success.
Before downloading either disk, Start checks cross-origin isolation,
SharedArrayBuffer availability, and actual instantiation of a standard shared
memory64 module. The probe allocates just one 64 KiB page and verifies the
BigInt memory-growth API; it does not promise that enough memory is available
to boot Linux or reserve the kernel's configured maximum. Unsupported engines
are not silently routed through wasm32.

The example only executes bounded commands; `run()` collects their outputs in
memory. The displayed recent boot console is capped at 64 KiB. Use `exec()` and
streaming output with cancellation for general-purpose long-running workloads.
This platform's NOMMU model is not an isolation boundary between mutually
untrusted Linux programs. Browser isolation does not make such programs safe
to run together in one instance.

The explicit `browser-tests-check-wasm64-example-chromium` and
`browser-tests-check-wasm64-example-firefox` checks exercise the actual packaged
page controls: boot, uname, exact UTF-8 file round-trip, stop/restart, absence of
the old file, and recovery after native `cat` reports failure. The exact outer
case must pass without skips/retries. Newly added checks require actual CI
results; the local server test and esbuild success do not establish browser
Linux execution.
The page check also removes COEP from the document response, verifies the
visible isolation diagnostic without disk downloads, then restores normal
hosting and continues the Linux controls check. Host probe tests distinguish
unsupported features, allocation failure, and an incorrect memory32 result;
they are not browser execution evidence.

The application, build recipe and local server are MIT. Included Linux and
BusyBox retain GPL terms, and other components retain their licenses. The
output retains the kernel package's `linux-build/` materials and license texts;
the root image contains the BusyBox notices. These are not a complete source
offer or release-compliance certification. Before distributing the bundle,
provide the required exact sources and build instructions for the selected
components, as discussed in the project's licensing documentation. This does
not change the ordinary Linux licensing boundary for independently developed
user programs.
