# Static C fork with application computation checkpoints

This independent candidate uses `sdk-fork-cooperative-poll` or its `-wasm64`
variant. Application source uses ordinary fork, wait and timer interfaces.
The compiler instruments application edges; the complete linked module passes
through the existing Asyncify finalizer once. The support objects and libc are
not coverage-instrumented by this profile.

An explicit private execution marker admits poll ABI 1 with fork. Checkpoints
defer throughout Asyncify unwind, live snapshot ownership and rewind. The host
tracks checkpoint entry as a kernel call, preserving callback fork refusal.
Existing host/kernel gates still control nested signal delivery and allocator
callbacks. This does not enable libc poll ABI 2 or dynamic loading with fork.

`fork-poll-check-both` requires three stages for each pointer width: timer
delivery before fork; repeated parent, child and grandchild computation with
private TLS/data and exact single reaping; callback fork refusal followed by
successful later fork and timer delivery. Each machine must emit one final pass
and finish the runner's shutdown gate. Frontend/model checks do not establish
actual Asyncify or Linux runtime acceptance.

Default SDKs and standalone fork/poll profiles remain separate. Static C,
single-thread fork and bounded continuation storage remain required; this does
not add C++ exception/SjLj composition or multithreaded fork support.

Original code is MIT licensed; SDK materials retain their upstream licenses.
