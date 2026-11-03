<!-- SPDX-License-Identifier: MIT -->

# Exec host-import admission

The existing private polling thread-pointer global must be mutable and match
the process memory width. Names and import kinds alone cannot establish that
the host can supply it. The loader checks its encoded type before allocating
the pending memory or committing Linux exec, returning ENOEXEC on mismatch.
Other global types are still skipped according to the existing Wasm parser;
this does not introduce the dynamic profile's numeric-function restrictions.

Host function imports must also match the fixed execution ABI: machine-word
syscall arguments/results, pointer arguments and fixed i32 control results.
Ordinary JS functions erase this distinction when linking; a valid module could
otherwise commit exec and fail only when it passes an incompatible value.
The loader copies the original type section verbatim into a function-import-only
module and links against inert, typed Wasm functions. It copies no user code,
start section, memory or data. Unrelated reference/recursive function types are
left to the engine, without applying the dynamic loader's numeric-only policy.

The engine-valid images vary TP mutability/type or syscall parameter width,
result width, arity and checkpoint result type. Small engine tests show that
the original JS imports accept the wrong function signatures while the new
typed gate rejects them; positive controls execute the matching image. A start
section negative control runs only when the original executable is instantiated,
never during the new admission check.

Executable admission additionally requires `_start` to export a function with
the existing no-argument, no-result entry ABI. Missing entries, non-function
exports and incompatible parameter/result types return ENOEXEC before commit.
The function index is resolved through the import and function sections; its
type is linked through the same inert engine probe, without running the entry.

The ordinary-SDK workload requires repeated incompatible images to return
ENOEXEC while preserving actual kernel TP, native TLS, a CLOEXEC descriptor and
its offset. A matching image must execute and exit through the standard syscall;
later rejection/spawn/wait must recover. Both widths require all five stages,
one final pass and machine shutdown. This covers supplied import types, not
exported ABI version values, arbitrary program behavior or every executable
initialization error. It adds no libc API or Linux syscall number.
