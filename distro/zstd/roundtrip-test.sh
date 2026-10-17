#!/bin/busybox sh
# SPDX-License-Identifier: MIT

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

seq 1 4000 >/tmp/data || fail "generating test data failed"

zstd -q -c /tmp/data >/tmp/data.zst || fail "compression failed"
zstd -d -q -c /tmp/data.zst >/tmp/data.out || fail "decompression failed"
cmp /tmp/data /tmp/data.out || fail "round-tripped data did not match the original"

# Exercise the upstream POSIX dictionary loader, not its malloc fallback.
# Both compression and decompression must work after the dictionary fd closes.
cp /tmp/data /tmp/dictionary || fail "dictionary preparation failed"
zstd --mmap-dict -D /tmp/dictionary -q -c /tmp/data >/tmp/dict.zst || fail "mapped dictionary compression failed"
zstd --mmap-dict -D /tmp/dictionary -d -q -c /tmp/dict.zst >/tmp/dict.out || fail "mapped dictionary decompression failed"
cmp /tmp/data /tmp/dict.out || fail "mapped dictionary roundtrip differed"
zstd --no-mmap-dict -D /tmp/dictionary -d -q -c /tmp/dict.zst >/tmp/dict.out || fail "malloc dictionary interoperability failed"
cmp /tmp/data /tmp/dict.out || fail "malloc dictionary roundtrip differed"

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
