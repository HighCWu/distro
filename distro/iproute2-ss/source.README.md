<!-- SPDX-License-Identifier: MIT -->

# iproute2 ss build materials

The archive is the complete upstream iproute2 7.3.0 release, without source
patches. This package builds its ss executable and the upstream libutil and
libnetlink archives; it does not publish or validate the entire iproute2 suite.
The release SHA256 is
`5c1789d290bba048a6135ed1ab81b0402dd0fb528d1f1421765c42b1fc3d6289`.
It matches the published kernel.org checksum; the PGP signature was not verified.

Build with the matching Wasm32 or Wasm64 fork-capable static C SDK because the
unmodified libutil source includes fork. The default SDK remains separate.
The recipe uses upstream configure/Make targets, static libraries and the
existing execution finalizer. Optional libbpf support is disabled through its
upstream configure option. No application C source is replaced or patched.

`BINARY_SHA256SUMS` identifies the final published executable after finalization.
`SHA256SUMS` covers the source archive, recipe and this file. The SDK materials
link preserves the execution support, libc/toolchain identities and licenses.
Upstream source notices and COPYING remain authoritative; the independent
recipe and this documentation are MIT.

The runtime check verifies live and closed UNIX/UDP/TCP sockets and ordinary
user access. It does not mount procfs, so missing diagnostic handlers cannot
be masked by ss reading `/proc/net` instead. This does not validate BPF,
administrative socket destruction, every ss option, or dynamic linking.
