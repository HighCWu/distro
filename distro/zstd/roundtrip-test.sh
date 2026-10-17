#!/bin/busybox sh
# SPDX-License-Identifier: MIT

fail() {
  printf 'vm test failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export LC_ALL=C

seq 1 4000 >/tmp/data || fail "generating test data failed"

zstd -q -c /tmp/data >/tmp/data.zst || fail "compression failed"
zstd -d -q -c /tmp/data.zst >/tmp/data.out || fail "decompression failed"
cmp /tmp/data /tmp/data.out || fail "round-tripped data did not match the original"

# Default and explicit malloc/read dictionaries must work without file mmap.
cp /tmp/data /tmp/dictionary || fail "dictionary preparation failed"
zstd -D /tmp/dictionary -q -c /tmp/data >/tmp/dict.zst || fail "default dictionary compression failed"
zstd --no-mmap-dict -D /tmp/dictionary -d -q -c /tmp/dict.zst >/tmp/dict.out || fail "malloc dictionary decompression failed"
cmp /tmp/data /tmp/dict.out || fail "malloc dictionary roundtrip differed"
zstd --no-mmap-dict -D /tmp/dictionary -q -c /tmp/data >/tmp/dict.zst || fail "malloc dictionary compression failed"
zstd -D /tmp/dictionary -d -q -c /tmp/dict.zst >/tmp/dict.out || fail "default dictionary decompression failed"
cmp /tmp/data /tmp/dict.out || fail "default dictionary roundtrip differed"

# Production kernels reject file mmap. Require the actual mapping failure,
# not a crash, missing option/file or silent fallback; neither mode emits data.
for mode in compress decompress; do
  status=0
  if test "$mode" = compress; then
    zstd --mmap-dict -D /tmp/dictionary -q -c /tmp/data >/tmp/mapped.out 2>/tmp/mapped.err || status=$?
  else
    zstd --mmap-dict -D /tmp/dictionary -d -q -c /tmp/dict.zst >/tmp/mapped.out 2>/tmp/mapped.err || status=$?
  fi
  test "$status" -eq 34 || fail "forced mapping did not return dictionary error 34: $mode"
  grep -F 'Invalid argument' /tmp/mapped.err >/dev/null || fail "forced mapping did not report EINVAL: $mode"
  test ! -s /tmp/mapped.out || fail "rejected mapping emitted output: $mode"
done
echo "zstd: malloc dictionaries verified; forced file mapping rejected"

# Binary bytes and multiple syscall-sized chunks must survive file and pipe I/O.
dd if=/dev/zero of=/tmp/binary bs=65536 count=16 2>/dev/null || fail "binary generation failed"
printf '\000\377\200binary-tail\000\376\001' >>/tmp/binary || fail "binary tail failed"
zstd -q -c /tmp/binary >/tmp/binary.zst || fail "binary compression failed"
zstd -d -q -c /tmp/binary.zst >/tmp/binary.out || fail "binary decompression failed"
cmp /tmp/binary /tmp/binary.out || fail "binary roundtrip differed"
cat /tmp/binary | zstd -q -c | zstd -d -q -c >/tmp/pipe.out || fail "streaming pipeline failed"
cmp /tmp/binary /tmp/pipe.out || fail "pipeline roundtrip differed"

for notice in LICENSE-BSD musl-COPYRIGHT compiler-rt-LICENSE.TXT; do
  test -s "/share/licenses/zstd/$notice" || fail "missing installed license: $notice"
done

# A truncated stream must be rejected with a nonzero exit.
head -c 32 /tmp/data.zst >/tmp/data.bad || fail "truncating the stream failed"
if zstd -d -q -c /tmp/data.bad >/dev/null 2>&1; then
  fail "decompressing a corrupted stream succeeded"
fi

echo "::vm-test::pass"
while :; do :; done
