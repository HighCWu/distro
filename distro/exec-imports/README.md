<!-- SPDX-License-Identifier: MIT -->

# Exec import-global admission

The existing private polling thread-pointer global must be mutable and match
the process memory width. Names and import kinds alone cannot establish that
the host can supply it. The loader checks its encoded type before allocating
the pending memory or committing Linux exec, returning ENOEXEC on mismatch.
Other global types are still skipped according to the existing Wasm parser;
this does not introduce the dynamic profile's numeric-function restrictions.

The images are engine-valid modules with the same names, ABI marker, entry
and shared memory. Only the TP global differs: matching, immutable, opposite
width, or floating point. Small engine tests reproduce the old LinkError and
execute the matching image. They do not instantiate a production image during
admission, so no module start code runs before exec commit.

The ordinary-SDK workload requires repeated incompatible images to return
ENOEXEC while preserving actual kernel TP, native TLS, a CLOEXEC descriptor and
its offset. A matching image must execute and exit through the standard syscall;
later rejection/spawn/wait must recover. Both widths require all three stages,
one final pass and machine shutdown. This validates the global contract only,
not every possible import/function signature or all executable ABI errors.
