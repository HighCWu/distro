#!/bin/busybox sh
# SPDX-License-Identifier: MIT
# Actual target workload: no replacement mmap syscall or application fallback.

fail() {
  printf 'vm test failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export LC_ALL=C
mount -t devtmpfs devtmpfs /dev || fail "mounting test devices failed"
mkdir -p /snapshot /ordinary || fail "creating dictionary mounts failed"
mount -t erofs -o ro /dev/vda /snapshot || fail "mounting authenticated dictionaries failed"
mount -t erofs -o ro /dev/vdb /ordinary || fail "mounting ordinary dictionaries failed"
seq 1 4000 >/tmp/data || fail "generating test data failed"

reject_mapping() {
  dictionary=$1
  compressed=$2
  diagnostic=$3
  for mode in compress decompress; do
    status=0
    if test "$mode" = compress; then
      zstd --mmap-dict -D "$dictionary" -q -c /tmp/data >/tmp/rejected.out 2>/tmp/rejected.err || status=$?
    else
      zstd --mmap-dict -D "$dictionary" -d -q -c "$compressed" >/tmp/rejected.out 2>/tmp/rejected.err || status=$?
    fi
    test "$status" -eq 34 || fail "rejected mapping did not exit 34: $mode $dictionary"
    grep -F "$diagnostic" /tmp/rejected.err >/dev/null || fail "mapping refusal diagnostic mismatch: $mode $dictionary"
    test ! -s /tmp/rejected.out || fail "rejected mapping emitted output: $mode $dictionary"
  done
}

accept_mapping() {
  dictionary=$1
  zstd --mmap-dict -D "$dictionary" -q -c /tmp/data >/tmp/mapped.zst || fail "forced dictionary compression failed"
  zstd --no-mmap-dict -D "$dictionary" -d -q -c /tmp/mapped.zst >/tmp/read.out || fail "malloc cross-decompression failed"
  cmp /tmp/data /tmp/read.out || fail "mapped compression roundtrip differed"
  zstd --mmap-dict -D "$dictionary" -d -q -c /tmp/read.zst >/tmp/mapped.out || fail "forced dictionary decompression failed"
  cmp /tmp/data /tmp/mapped.out || fail "mapped decompression roundtrip differed"
}

for size in 65535 65536 65537 131071 131072 131073; do
  dictionary=/snapshot/dictionary-$size
  test "$(wc -c <"$dictionary")" -eq "$size" || fail "immutable dictionary size mismatch"
  zstd --no-mmap-dict -D "$dictionary" -q -c /tmp/data >/tmp/read.zst || fail "ordinary dictionary compression failed"
  if test "$size" -le 131072; then
    # Force the upstream PROT_READ/MAP_PRIVATE mmap in BOTH directions.
    # Cross-decode with malloc/read so a matching pair cannot hide corruption.
    accept_mapping "$dictionary"
    echo "zstd: immutable forced mapping boundary $size verified"
  else
    reject_mapping "$dictionary" /tmp/read.zst 'Out of memory'
    echo "zstd: immutable mapping ceiling $size rejected"
  fi
  # Standard NOMMU private copies do not require immutable backing.
  # The ordinary disk and writable file still obey the same capacity limit.
  cp "$dictionary" /tmp/dictionary || fail "copying mutable dictionary failed"
  if test "$size" -le 131072; then
    accept_mapping "/ordinary/dictionary-$size"
    accept_mapping /tmp/dictionary
    echo "zstd: regular forced mapping boundary $size verified"
  else
    reject_mapping "/ordinary/dictionary-$size" /tmp/read.zst 'Out of memory'
    reject_mapping /tmp/dictionary /tmp/read.zst 'Out of memory'
  fi
done

for notice in LICENSE-BSD musl-COPYRIGHT compiler-rt-LICENSE.TXT; do
  test -s "/share/licenses/zstd/$notice" || fail "missing installed license: $notice"
done
echo "zstd: snapshot ordinary and mutable private copies verified"
echo "::vm-test::pass"
while :; do :; done
