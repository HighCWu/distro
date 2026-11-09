#!/bin/busybox sh
# SPDX-License-Identifier: MIT
export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export LC_ALL=C SHELL=/bin/sh
sort_binary=${1:-/bin/sort}

fail() {
  printf '::vm-test::fail: standard sort: %s\n' "$*"
  exit 1
}

version=$("$sort_binary" --version) || fail 'version'
case "$version" in
*'GNU coreutils'*) ;;
*) fail 'expected GNU sort' ;;
esac
work=$(mktemp -d /tmp/sort-standard-fork.XXXXXX) || fail 'temporary directory'
trap 'rm -rf "$work"' 0
mkdir "$work/tmp" || fail 'sort temporary directory'
awk 'BEGIN { for (i = 4096; i >= 1; i--) printf "%06d payload-%06d\n", i, i % 97 }' \
  >"$work/input" || fail 'descending input'
awk 'BEGIN { for (i = 1; i <= 4096; i++) printf "%06d payload-%06d\n", i, i % 97 }' \
  >"$work/expected" || fail 'independent expected output'
export SORT_HELPER_LOG="$work/helper.log"
cat >"$work/compress" <<'HELPER'
#!/bin/sh
case "$#:$*" in
0:) mode=compress ;;
1:-d) mode=decompress ;;
*) exit 20 ;;
esac
printf '%s\n' "$mode" >>"$SORT_HELPER_LOG" || exit 21
if [ "${SORT_FAIL:-none}" = "$mode" ]; then
  cat >/dev/null || exit 22
  printf 'failed-%s\n' "$mode" >>"$SORT_HELPER_LOG" || exit 23
  case "$mode" in
  compress) exit 7 ;;
  decompress) exit 9 ;;
  esac
fi
case "$mode" in
compress) exec gzip -c ;;
decompress) exec gzip -dc ;;
esac
HELPER
chmod +x "$work/compress" || fail 'helper executable'

check_output() {
  cmp "$work/expected" "$work/output" || fail 'external sort output'
  compressed=$(grep -c '^compress$' "$SORT_HELPER_LOG") || fail 'compression helper did not run'
  decompressed=$(grep -c '^decompress$' "$SORT_HELPER_LOG") || fail 'decompression helper did not run'
  [ "$compressed" -ge 2 ] && [ "$decompressed" -ge 2 ] || fail 'multiple external runs required'
  [ -z "$(ls -A "$work/tmp")" ] || fail 'sort left temporary files'
}

# Keep upstream's sorting process single-threaded while forcing several real
# compressed runs. The helper log rejects the fork-free uncompressed fallback.
SORT_FAIL='none' "$sort_binary" --parallel=1 -S 64K -T "$work/tmp" \
  --compress-program="$work/compress" "$work/input" >"$work/output" || fail 'compressed external sort'
check_output
echo 'standard sort: original fork, helper exec, gzip compression and decompression pass'

: >"$SORT_HELPER_LOG"
SORT_FAIL='compress' "$sort_binary" --parallel=1 -S 64K -T "$work/tmp" \
  --compress-program="$work/compress" "$work/input" >"$work/output" 2>"$work/error"
status=$?
[ "$status" -eq 2 ] || fail "compression failure status $status"
grep -q '^failed-compress$' "$SORT_HELPER_LOG" || fail 'compression failure helper not reached'
grep -q 'terminated abnormally' "$work/error" || fail 'compression child diagnostic'
[ -z "$(ls -A "$work/tmp")" ] || fail 'compression failure left temporary files'
echo 'standard sort: nonzero compression child propagates and cleans temporary files pass'

: >"$SORT_HELPER_LOG"
SORT_FAIL='decompress' "$sort_binary" --parallel=1 -S 64K -T "$work/tmp" \
  --compress-program="$work/compress" "$work/input" >"$work/output" 2>"$work/error"
status=$?
[ "$status" -eq 2 ] || fail "decompression failure status $status"
grep -q '^compress$' "$SORT_HELPER_LOG" || fail 'decompression case has no compressed runs'
grep -q '^failed-decompress$' "$SORT_HELPER_LOG" || fail 'decompression failure helper not reached'
grep -q 'terminated abnormally' "$work/error" || fail 'decompression child diagnostic'
[ -z "$(ls -A "$work/tmp")" ] || fail 'decompression failure left temporary files'
echo 'standard sort: nonzero decompression child propagates and cleans temporary files pass'

: >"$SORT_HELPER_LOG"
SORT_FAIL='none' "$sort_binary" --parallel=1 -S 64K -T "$work/tmp" \
  --compress-program="$work/compress" "$work/input" >"$work/output" || fail 'later compression recovery'
check_output
rm -rf "$work" || fail 'filesystem cleanup'
trap - 0
echo 'standard sort: later compressed sort and filesystem cleanup recover pass'
echo '::vm-test::pass'
if [ "${SORT_NATIVE_TEST:-0}" != 1 ]; then
  while :; do sleep 1; done
fi
