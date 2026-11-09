# Static C fork with application and libc computation checkpoints

This independent candidate uses `sdk-fork-cooperative-poll` or its `-wasm64`
variant. Application source uses ordinary fork, wait and timer interfaces.
The compiler instruments application edges; the complete linked module passes
through the existing Asyncify finalizer once. The support objects and libc are
not coverage-instrumented by this profile.

An explicit private execution marker admits poll ABI 1 with fork. Checkpoints
defer throughout Asyncify unwind, live snapshot ownership and rewind. The host
tracks checkpoint entry as a kernel call, preserving callback fork refusal.
Existing host/kernel gates still control nested signal delivery and allocator
callbacks.

The `sdk-fork-cooperative-poll-libc` and `-wasm64` candidates also instrument
libc. They select poll ABI 2 and the matching fork composition marker 2. Both
markers must be zero-argument functions returning the same supported version.
The existing per-instance thread-pointer global and native TLS ownership guard
control readiness during thread startup and exit. Checkpoints use the same
unwind, snapshot and rewind gates as the application-only profile. The execution
support objects are compiled independently of coverage instrumentation.

`fork-poll-check-both` requires three stages for each pointer width: timer
delivery before fork; repeated parent, child and grandchild computation with
private TLS/data and exact single reaping; callback fork refusal followed by
successful later fork and timer delivery. Each machine must emit one final pass
and finish the runner's shutdown gate. Frontend/model checks do not establish
actual Asyncify or Linux runtime acceptance.

`fork-poll-libc-check-both` includes both widths of the original three-stage
profile and the new four-stage libc profile. Its additional stage requires timer
delivery inside an application wrapper without coverage callbacks, while the
actual libc `memchr` executes through a volatile function pointer. It checks this
before fork and in both parent and child after a pthread has joined, with private
TLS and data preserved. Fork retries use the existing bounded thread-exit
recovery path. Every machine must finish its complete stages, unique final pass
and shutdown gate.

Native references use a test-only compile definition to omit the private
callback-fork refusal probe and exit normally after the pass marker. Their
distinct native recovery label records that scope. The target configuration
continues to exercise callback refusal through the existing third stage.

Default SDKs and standalone fork/poll profiles remain separate. Static C,
single-thread fork and bounded continuation storage remain required; this does
not add C++ exception/SjLj composition or multithreaded fork support.

Original code is MIT licensed; SDK materials retain their upstream licenses.
