<!-- SPDX-License-Identifier: MIT -->

# Exec architecture thread state

The Wasm architecture clears its kernel-owned thread pointer in flush_thread,
at the ordinary Linux exec commit point. Image lookup and module preparation
failures must retain the old pointer and TLS. This does not change libc's TLS
layout or add a syscall/import/API.

The ordinary SDK consumer checks missing and malformed executable failures,
then uses standard posix_spawn/waitpid to execute a libc-free observer twice.
That observer reads the existing get_thread_area execution import before any
libc startup, refusing a nonzero pointer with status 31. The parent retains its
own TP and native TLS. A later ordinary libc executable must initialize fresh
TLS, and another raw entry must still work. All three stages, a unique final
pass and machine shutdown are required at both widths.
The aggregate `exec-thread-state-check-both` also requires the existing
application-polling and fork/descriptor-exec consumers at both widths, using
this same kernel revision rather than reusing older kernel acceptance.

The small compiler probe runs the actual reset body with thread isolation and
an omitted-reset negative control. It executes the real observer with both
zero and inherited TP imports, and compiles/analyzes the ordinary consumer.
These checks are not proof of Linux exec behavior; public CI provides that
separate acceptance. No continuation fork, MMU or libc API is added.
