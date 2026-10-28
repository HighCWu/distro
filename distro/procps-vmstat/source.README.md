<!-- SPDX-License-Identifier: MIT -->

# procps-ng vmstat source

This output preserves the selected, unmodified procps-ng 4.0.7 source archive,
the integration recipe and their checksums. `BINARY_SHA256SUMS` identifies the
matching installed `bin/vmstat`, verified from its package root. The executable
and static libproc2 dependency are built from upstream code; this is not the
complete procps-ng utility suite. Upstream COPYING/COPYING.LIB remain in force;
our MIT build integration does not relicense upstream code.

Rebuild with the matching distro checkout, flake.lock, platform, compiler,
musl and compiler-rt sources. These toolchain inputs and their sources are not
contained in this small source output; it is not an offline build environment
or a claim of complete release-wide corresponding-source compliance. Runtime
license notices are in `/share/licenses/procps-vmstat/`.
