# BusyBox binary and linked runtime notices

BusyBox is licensed under GPL-2.0-only. See `LICENSE` for the upstream license
text. The binary is statically linked with musl and may include compiler-rt
builtins; their upstream notices are preserved in `musl-COPYRIGHT` and
`compiler-rt-LICENSE.TXT`. These texts come from the same pinned sources used
by the selected wasm32 or wasm64 build.

The repository's MIT license applies to its own build and test infrastructure,
not to BusyBox or third-party runtime code. These notices do not impose the
BusyBox license on unrelated programs merely running on the same system.

This directory contains license notices, not a corresponding-source bundle or
source offer. A distributor of the BusyBox binary must separately fulfill the
applicable GPL corresponding-source obligations, including the modifications
and build materials needed for that binary. Do not treat this directory alone
as evidence that a release is ready for distribution.
