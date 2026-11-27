#!/bin/busybox sh
# SPDX-License-Identifier: MIT
export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export LC_ALL=C
fail() {
  echo "::vm-test::fail: crypto tools: $*"
  exit 1
}
sum=/libexec/libkcapi/sha256sum
sum224=/libexec/libkcapi/sha224sum
mount -t proc proc /proc || fail 'mount proc'
(cd / && sha256sum -c /crypto-tools.sha256) || fail 'final upstream binary identities'
version=$("$sum" --version 2>&1) || fail 'hasher version'
case "$version" in
*libkcapi*1.5.1*) ;;
*) fail "unexpected hasher version: $version" ;;
esac
work=$(mktemp -d /tmp/crypto-tools.XXXXXX) || fail 'temporary directory'
printf abc >"$work/abc" || fail 'abc fixture'
: >"$work/empty" || fail 'empty fixture'
check_file() {
  report=$("$1" "$2") || fail 'upstream file hash'
  actual=${report%% *}
  test "$actual" = "$3" || fail 'independent known digest'
}
check_file "$sum" "$work/abc" ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
check_file "$sum" "$work/empty" e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
check_file "$sum224" "$work/abc" 23097d223405d8228642a477bda255b32aadbce4bda0b3f7e36c9da7
echo 'crypto tools: upstream identity, version and Netlink-discovered SHA-224/SHA-256 pass'

dd if=/dev/zero of="$work/large" bs=65536 count=16 2>/dev/null || fail 'large binary fixture'
printf '\000\001\002\003\004\005\006\007\010\011\012\013\014\015\016\017\020' >>"$work/large" || fail 'binary tail'
check_file "$sum" "$work/large" 0630621d530a1f78a0190ed4f57c1beb461aa951b2d44e5f4ab082500cfb7a3c
"$sum" "$work/large" >"$work/checks" || fail 'create checksum list'
"$sum" -c "$work/checks" || fail 'upstream checksum verification'
printf '0000000000000000000000000000000000000000000000000000000000000000  %s\n' "$work/abc" >"$work/bad" || fail 'bad checksum fixture'
if "$sum" -c "$work/bad" >"$work/negative" 2>&1; then fail 'bad checksum unexpectedly accepted'; fi
check_file "$sum" "$work/abc" ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
echo 'crypto tools: large binary mapping/splice, checksum rejection and recovery pass'

for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  printf '\013' >>"$work/key" || fail 'public HMAC fixture key'
done
printf 'Hi There' >"$work/message" || fail 'HMAC message'
digest=$(kcapi-dgst -c 'hmac(sha256)' --keyfd 3 --hex -i "$work/message" 3<"$work/key") || fail 'upstream keyed digest'
test "$digest" = b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7 || fail 'RFC 4231 HMAC bytes'
if kcapi-dgst -c linux-wasm-nonexistent-algorithm --hex -i "$work/abc" >"$work/unknown" 2>&1; then fail 'unknown algorithm accepted'; fi
echo 'crypto tools: standard keyed digest and unavailable algorithm errors pass'

printf abc | /libexec/crypto-tools/unpriv-exec "$sum" >"$work/unpriv" || fail 'ordinary unprivileged program'
report=$(cat "$work/unpriv") || fail 'unprivileged digest output'
test "${report%% *}" = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad || fail 'unprivileged kernel digest'
for notice in COPYING COPYING.bsd COPYING.gplv2 LOCAL-ADDITIONS.MIT musl-COPYRIGHT compiler-rt-LICENSE.TXT; do
  test -s "/share/licenses/libkcapi/$notice" || fail "missing upstream notice $notice"
done
for notice in LICENSE.MIT musl-COPYRIGHT compiler-rt-LICENSE.TXT; do
  test -s "/share/licenses/crypto-tools/$notice" || fail "missing helper notice $notice"
done
rm "$work/abc" "$work/empty" "$work/large" "$work/checks" "$work/bad" "$work/negative" "$work/key" "$work/message" "$work/unknown" "$work/unpriv" || fail 'fixture cleanup'
rmdir "$work" || fail 'temporary directory cleanup'
umount /proc || fail 'proc cleanup'
echo 'crypto tools: unprivileged Netlink/AF_ALG execution, notices and cleanup pass'
echo '::vm-test::pass'
while :; do sleep 1; done
