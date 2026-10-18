<!-- SPDX-License-Identifier: MIT -->

# Standalone Linux wasm64 embedding example

This is a small application using the public kernel and agent APIs, not a
terminal distribution or test fixture. It bundles a matching wasm64 kernel,
native agent boot disk and a minimal or Python-equipped ext4 root. The page starts/stops
Linux, runs native `uname`, writes bounded UTF-8 text through the file API and
reads it using native `cat`. It also imports a developer-selected Linux wasm64
executable into the selected root and runs it through the public streaming
process API, without shell interpolation.

Build heavy assets in public CI:

```console
nix build .#wasm64-example --out-link result-wasm64-example -L
node result-wasm64-example/server.mjs
```

## Optional Python + Git workspace profile

`wasm64-python-git-example` uses the same controls with a 512 MiB ext4 root
containing Python, Git, BusyBox, ncurses, OpenSSL and CA certificates. This is
disk capacity, not a memory ceiling. Build it in public CI with
`nix build .#wasm64-python-git-example`, then serve the complete output using
its `server.mjs`. The minimal and Python-only profiles are unchanged.

The output includes `git-workspace.pyz` and `workspace-source/`. Download the
archive from the served `/git-workspace.pyz` URL, start Linux, select Python
explicitly, and select the downloaded file. Leave standard input empty and
set arguments to `["write", "/root/workspace"]`. The result reports a Git HEAD.
Run the same archive with `["read", "/root/workspace", "THE_REPORTED_HEAD"]` to
check the repository, clone, Python hook, binary application and SQLite data.
The full 40-character HEAD is required, not the placeholder text. Both phases
also work with ordinary Linux Python/Git; the application and its source are MIT.
Write refuses an existing workspace; read creates a new clone and is not an
idempotent synchronization command. It does not install dependencies or use
public-network services. Only run trusted applications and repositories.

Temporary memory remains the default. To keep a workspace across reloads, use
the explicit OPFS controls described below. A successful component check does
not establish this combined page's compatibility; its Chromium/Firefox
results are tracked separately, including the new persistence case.
This optional recipe is not a license-approved binary release. Python/Readline
obligations, Git's OpenSSL linkage review and complete corresponding-source
delivery remain separate requirements; bundled notices do not relicense dependencies.

## Optional Python profile

`wasm64-python-example` uses the same page, kernel, native agent and public
process API with a 256 MiB root containing CPython, its standard library,
ncurses, OpenSSL and CA certificates. The default `wasm64-example` retains the
64 MiB minimal root and disables Python selection. Build the Python profile
in public CI with `nix build .#wasm64-python-example`; serve or relocate its
complete output directory just as described below. New profile build and
browser checks require their own CI results; older native-only successes
do not establish Python launcher support.

Start Linux, select **Python .pyz application** under **Program type**, select
a trusted ZIP-format `.pyz`, and choose **Import and run program**. The import
does not guess the file type: a ZIP selected in Wasm mode is rejected. This
small launcher accepts archives beginning with a ZIP local-file header, not
zipapps with a prepended shebang. For example, use this project's
`distro/python/build-example.py` to generate a compatible application archive.
Archives remain limited to 16 MiB; the ZIP header is only a format hint, not
validation of contents, expanded size, runtime dependencies or resource usage.

The launcher copies bytes to `/root/application.pyz` and invokes
`/usr/bin/python3 -I /root/application.pyz` followed by literal JSON arguments.
It does not extract files in JavaScript, interpolate a shell, install pip
packages or execute Wasm directly from the archive. Isolated mode ignores
Python environment variables and the current directory for imports; package
code/resources must be present in the archive, installed stdlib or supported
runtime paths. It is not a security sandbox. Native extension imports,
arbitrary fork and other unavailable platform features do not become supported
merely because an archive can be imported. Interpreter errors and nonzero exit
status remain failures.

The existing text/binary stdin, concurrent output, cancellation, Stop and
file-download controls are reused. Output on the page is still a bounded UTF-8
preview, not raw binary. Changes and the uploaded archive disappear on stop
in temporary mode; OPFS is explicit and does not add an interactive terminal.
The interpreter statically links GNU Readline and retains GPL obligations.
License notices in the root are not a complete corresponding-source delivery,
and neither the interpreter nor the bundled system may be relabeled MIT.

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

The default temporary mode downloads a fresh root image into host memory on
every start. Writes disappear after stop, reload or failure: its no-op block
flush only acknowledges in-memory backing, not durable storage. It never
silently falls back from OPFS. The 64 MiB minimal image (256 MiB for Python,
512 MiB for Python + Git), kernel and per-process
memories consume additional browser resources. Memory64 and shared-memory
browser support are required; there is no wasm32 fallback or transpiler here.
Runtime errors remain visible and are not converted to compatibility success.
Before downloading either disk, Start checks cross-origin isolation,
SharedArrayBuffer availability, and actual instantiation of a standard shared
memory64 module. The probe allocates just one 64 KiB page and verifies the
BigInt memory-growth API; it does not promise that enough memory is available
to boot Linux or reserve the kernel's configured maximum. Unsupported engines
are not silently routed through wasm32.

## Explicit OPFS storage

Choose **Create new OPFS disk**, enter a name of 1–48 lowercase ASCII letters,
digits or hyphens, and choose **Start Linux**. Names are local to this browser
profile and origin; the file is `linux-wasm64-NAME.ext4`. Creation initializes
from this bundle's root template and refuses an existing file, including an
incomplete file left by failed initialization. Choose a new name after such a
failure; this page does not delete or overwrite existing disks automatically.
Creation pipes the HTTP response stream into OPFS with backpressure instead of
buffering the entire template in JavaScript. Linux starts only after the write
stream closes successfully. This avoids that explicit whole-image copy, not all
browser buffering, storage quota requirements or Linux runtime memory costs.

Finish applications and other writers, then choose **Sync and stop Linux**.
This runs native `/bin/sync`, closes Linux, drains console output, and waits
for the disk worker's flush/close acknowledgement before enabling another
start. A sync failure leaves Linux open for retry or immediate Stop; disk
close failures remain visible. This is not a transaction or snapshot against
background writers. **Stop Linux** remains immediately available during an
application and may discard unsynced Linux writes; do not treat it as Save.

After a reload, select **Open existing OPFS disk** and enter the same name.
Opening does not download the root template, create a missing file, resize or
truncate the disk. Use the same runtime profile and a compatible bundle; this
small example does not migrate disks or validate their installed packages.
Python/Git labels describe the bundle's template, not an inspected old disk.
Web Locks prevent these controls in another page of the same origin from
opening or initializing the same named disk concurrently. The disk worker
also uses an exclusive synchronous OPFS access handle. Do not bypass these
controls with other applications accessing the same file.

OPFS and Web Locks must both be available; errors never become a fresh
temporary root. Browser quota, eviction, clearing site data, abrupt page or
browser termination and power-loss recovery are not guaranteed. Keep separate
backups. No automatic background save, unload handler or persistent-storage
permission guarantee is provided. These storage controls do not change Linux
NOMMU, user ABI or the trust boundary between programs in one instance.

The combined browser test retains its temporary-memory case and adds a real
controls-level OPFS case: original write report, sync/stop, refused overwrite,
page reload, root-template requests blocked, existing-disk read using the same
HEAD, SQLite/Git/Python validation, and exact downloaded payload bytes. Both
cases require their own new Chromium and Firefox acceptance; older OPFS SDK
checks are not evidence that these new controls have passed.

The preset commands use `run()` to collect bounded outputs. Imported programs
use `exec()` with concurrent stdout/stderr consumption and cancellation instead
of collecting all output. The displayed recent boot console and application
output are each capped at 65,536 characters.
This platform's NOMMU model is not an isolation boundary between mutually
untrusted Linux programs. Browser isolation does not make such programs safe
to run together in one instance.

## Downloading generated files

Enter an absolute Linux path under **Download a Linux file**, choose **Prepare
download**, then **Save prepared file**. This retrieves exact binary bytes,
including NUL and non-UTF-8 data, without passing through the text preview or
uploading them to the server. The browser chooses where to save the file.

Only regular files up to 16 MiB are supported in this small example. Metadata
is checked before open and again on the opened handle; actual bytes read are
also capped in case the file grows. Preparation buffers the file in browser
memory and closes the handle before publishing a Blob URL. Read/close errors
do not offer a partial download. The next preparation, Stop, or unexpected
machine closure revokes the old link; stale operations cannot publish into a
replacement instance. A saved local file is independent of the temporary disk.

Finish writing before preparation. This is not snapshot isolation against
concurrent writers, a security boundary against path replacement, a large-file
streaming export, or persistent Linux storage. Stop remains available during
preparation; the example does not offer a separate download-cancel operation.

## Importing your own program

Compile a static executable with the matching Linux wasm64 SDK, for example
inside the repository's `sdk-wasm64` development shell:

```console
wasm-linux-cc -Wall -Wextra your-program.c -o application.wasm
```

Start Linux, select the resulting file, enter arguments as a JSON string array
(for example `["hello world", "--count", "3"]`), then choose **Import and run
program**. The filename is not interpreted as a path: bytes are written to
`/root/application.wasm`, marked executable, and executed with `/root` as cwd.
Nothing is uploaded to the HTTP server. This overwrites that one application
path in the selected root. Temporary mode uses a fresh root on a later start;
OPFS mode retains the imported file subject to the synchronization limits above.

Files are limited to 16 MiB and must have a version-1 Wasm header; arguments
are at most 64 NUL-free strings in 8192 JSON characters. These are UI/resource
bounds, not ABI or security validation. The binary must use this Linux SDK's
wasm64 ABI, not WASI, wasm32 or ELF; the native loader reports incompatible
programs rather than translating them. The minimal root does not provide
arbitrary dependencies or dynamic libraries. In **UTF-8 text** mode, standard input receives the text
from the page's optional UTF-8 input field followed by EOF. Input is limited to
65,536 characters before any import or launch, and sending it runs concurrently
with draining both outputs to avoid pipe-filter deadlock. Empty input retains
the previous immediate-EOF behavior. A filter may intentionally close stdin
after a prefix: producer `EPIPE` is tolerated, but its actual exit status and
both output streams are still required; other input errors or cancellation
remain failures. This text mode is finite input, not an interactive terminal
or a process input quota. Stdout and stderr are
decoded separately as UTF-8; their displayed interleaving is nondeterministic,
and older output is discarded rather than retained invisibly.

The launcher now selects the SDK's `stdinMode: "streaming"`, so its write
awaits native pipe acceptance while both outputs are drained. This avoids an
additional compatibility-mode background input queue, without changing the
page's text/size limits. The earlier `c58929a` browser result below predates
this mode; the updated implementation requires a new target result.

Choose **Local binary file** as the standard-input source to stream a selected
file's exact bytes instead. A file is required in that mode; the text field is
ignored, and selecting a file while in text mode does not change text input.
An empty file sends EOF. The input filename is not passed as an argument or
written into Linux: `File.stream().pipeTo(child.stdin)` sends bytes with SDK
backpressure, without `arrayBuffer()` of the whole input or an HTTP upload.
No additional input-file size cap or hard memory/CPU quota is imposed. Use
Cancel application or Stop Linux for long-running input, retain concurrent
output draining, and account for browser/stream buffers and application memory.
Outputs are still UTF-8 previews, not a binary download facility. Early consumer
EPIPE cancels the remaining file source but still requires the real process
status and both output streams; file read errors and cancellation stay failures.

Eight added host checks cover byte preservation, empty/missing inputs, source
failure/cancellation, prefix EPIPE, UI source choice and the C fixture (36 related
checks total). The host-compiled fixture verifies every byte of a known 512 KiB
plus 17-byte pattern, count/EOF, and rejection of corruption. The real page check
uses that SDK-built fixture through the actual binary input picker, including
empty input and a prefix consumer. This extension has now passed its exact
page case in Firefox at `40c84bd` and Chromium at `4ebeb62`: each run verified
all 111 bundle files and completed with zero skips/retries. These cases cover
the actual program/input pickers, binary pattern, prefix and empty-file input,
plus the existing text, exit-status, cancellation and restart controls. They
do not validate later SDK file-stream type checks, chunk ordering or BYOB reads;
those revisions require their own native public-API checks.

**Cancel application** aborts the process capability, and the UI waits for
process/pipe cleanup before enabling another action. Nonzero exit status and
errors remain visible; neither is converted to success. This is not a global
timeout, descendant-process-group cleanup, CPU/memory quota, or safe execution
of untrusted code. A program can change or damage the same Linux instance and
its files. Only run trusted programs, and retain the licenses/notices required
by the components linked into your own binary.

**Stop Linux** stays available during application or filesystem work. Unlike
single-process cancellation, it requests closure of the whole machine and
discards the temporary disk. It does not wait behind application completion:
the UI invalidates the old operation, requests machine closure, and waits for
the machine and boot-console stream before allowing a restart. Late output,
errors, or file-operation continuations from the old instance cannot update
the replacement instance or run a command there. Closure errors stay visible.
This still depends on the runtime's machine-close contract; it is not a hard
browser deadline, graceful filesystem shutdown, or persistence guarantee.
Five mock-host UI regressions cover these ownership/stop/restart races, including
delayed machine closure. Together with the other example/packaging host checks,
28 tests pass. The real browser case now stops a waiting imported program and
restarts Linux; its verified Chromium result is recorded below.

Fourteen host regressions verify import/argument validation, executable mode,
literal argv, UTF-8 input/output, nonzero status, cancellation and failure cleanup,
including stdin limits, producer EPIPE, and concurrent input/output progress.
They do not prove Linux execution. The browser check separately compiles a
small MIT C program with the SDK, selects that file through the actual input,
checks literal Unicode arguments and both streams, exact Unicode stdin round-trip,
prefix-only reading of substantial input, a nonzero exit, cancellation
after an execution marker, and native `uname` after cleanup. This program is a
test-only input, not installed into or shipped with the minimal application
root. The verified Chromium result is recorded below; Firefox remains separate.

The explicit `browser-tests-check-wasm64-example-chromium` and
`browser-tests-check-wasm64-example-firefox` checks exercise the actual packaged
page controls: boot, uname, exact UTF-8 file round-trip, stop/restart, absence of
the old file, and recovery after native `cat` reports failure. The exact outer
case must pass without skips/retries. Newly added checks require actual CI
results; the local server test and esbuild success do not establish browser
Linux execution.
The corrected source-directory input has passed actual Nix application
packaging and the 111-file integrity inventory. A later failure occurred before
browser execution because the copied store `node_modules` directory was
read-only when the test suite added Playwright links. The suite now enables
owner write permission only on that copied directory, not recursively on
application payloads. A host regression reproduces the old permission failure
and verifies link creation without modifying payload permissions or bytes;
the corrected baseline Chromium run at distro `bfcc295` has passed its exact
control case without skips/retries, including native file operations and
stop/restart. That earlier version did not include developer-program import
or the subsequent active-application Stop behavior.
The extended Chromium run at distro `c58929a` has now passed the exact page case
with zero skips/retries and all 111 bundle files verified. Its SDK-built upload
checks literal Unicode argv, both outputs, exact UTF-8 stdin, a prefix-reading
filter fed 65,536 Chinese characters, exit 37, cancellation, active-application
Stop and restart. This does not establish Firefox coverage, interactive TTY,
durable storage or validation of later SDK revisions.
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
