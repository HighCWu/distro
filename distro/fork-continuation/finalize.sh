# SPDX-License-Identifier: MIT
# shellcheck shell=bash
if [[ $# -ne 2 ]]; then
  echo "usage: wasm-linux-fork-finalize linked.wasm output.wasm" >&2
  exit 64
fi
if [[ ! -f $1 || $1 -ef $2 ]]; then
  echo "input must exist and output must be a different file" >&2
  exit 64
fi
# Never truncate an existing output on a failed transform. The temporary file
# lives beside the output so publication is a same-filesystem rename.
destination=$2
temporary=$(mktemp -- "${destination}.tmp.XXXXXX")
trap 'rm -f -- "$temporary"' EXIT
@wasmOpt@ "$1" --enable-threads --enable-bulk-memory --enable-mutable-globals \
  --enable-sign-ext --enable-nontrapping-float-to-int --enable-memory64 \
  --enable-exception-handling --asyncify \
  --pass-arg=asyncify-imports@linux_fork_v1.checkpoint \
  --pass-arg=asyncify-asserts -o "$temporary"
chmod 0755 -- "$temporary"
mv -f -- "$temporary" "$destination"
