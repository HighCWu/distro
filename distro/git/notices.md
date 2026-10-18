<!-- SPDX-License-Identifier: MIT -->

# Selected Git and linked dependency notices

Git 2.55.0 uses GPL version 2; see the unmodified `git-COPYING`. The
SHA-1 collision-detection implementation and reftable retain their own
unmodified license texts. `compat-regex/` preserves the six upstream regex
source files, including their original LGPL copyright/license headers,
because this build selects Git's bundled regex rather than musl's regex.
These selected files are not the complete Git source or all license texts.

`run-command-posix-spawn.patch` is the packaged default Git modification.
It replaces the fork/exec child-launch path with posix_spawn, file actions
and synchronous spawn error reporting; unsupported daemonization still
fails rather than pretending to create a background process. The patch
remains subject to Git's upstream licensing; `notice-tools-MIT` applies
only to the project's own notice installation/checking infrastructure.
Custom derivation overrides must separately collect their actual patches
and modification records; this selected installer does not discover them.

`linked/` preserves selected notices from the exact curl output used to
link this Git HTTP helper: libcurl, zlib, OpenSSL, musl, compiler-rt and the
libcurl integration. Disabling Git's direct OpenSSL API does not remove
OpenSSL from the static libcurl dependency chain. The build does not infer
or grant an OpenSSL exception for Git, or certify that this link combination
is redistributable; its license compatibility requires separate review.

`SHA256SUMS` checks the bytes of these selected files, not source origin,
license completeness or legal sufficiency. This directory is not a full
corresponding-source bundle, source offer, SBOM or release approval. Before
redistribution, preserve all required upstream notices and license texts,
review the actual linked components, and provide required source and build
information through a durable release channel. The MIT notice tools do
not relicense Git, dependencies or the system. Independent applications
retain the ordinary Linux user-program licensing boundary, subject to
their own source and dependencies.
