#!/bin/busybox sh
# SPDX-License-Identifier: MIT
export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export LC_ALL=C SHELL=/bin/sh
split_binary=${1:-/bin/split}

fail() {
  printf '::vm-test::fail: standard split: %s\n' "$*"
  exit 1
}

version=$("$split_binary" --version) || fail 'version'
case "$version" in
*'GNU coreutils'*) ;;
*) fail 'expected GNU split' ;;
esac
work=$(mktemp -d /tmp/split-standard-fork.XXXXXX) || fail 'temporary directory'
trap 'rm -rf "$work"' 0
printf 'one\ntwo\nthree\nfour\nfive\nsix\n' >"$work/input" || fail 'input'

# The prefix proves that the filter actually ran; plain splitting is insufficient.
# shellcheck disable=SC2016 # FILE belongs to each filter's environment.
"$split_binary" -l 2 \
  --filter='{ printf "filtered:%s\n" "${FILE##*/}"; cat; } > "$FILE"' \
  "$work/input" "$work/piece_" || fail 'sequential filters'
printf 'filtered:piece_aa\none\ntwo\n' >"$work/expected"
cmp "$work/expected" "$work/piece_aa" || fail 'first filtered piece'
printf 'filtered:piece_ab\nthree\nfour\n' >"$work/expected"
cmp "$work/expected" "$work/piece_ab" || fail 'second filtered piece'
printf 'filtered:piece_ac\nfive\nsix\n' >"$work/expected"
cmp "$work/expected" "$work/piece_ac" || fail 'third filtered piece'
echo 'standard split: unmodified fork, pipe, FILE environment and filter exec pass'

# Concurrent filter processes must close earlier inherited pipe ends for EOF.
# shellcheck disable=SC2016 # FILE is expanded after split creates the child.
"$split_binary" -n r/3 --filter='cat > "$FILE"' "$work/input" "$work/round_" || fail 'round-robin filters'
printf 'one\nfour\n' >"$work/expected"
cmp "$work/expected" "$work/round_aa" || fail 'first round-robin piece'
printf 'two\nfive\n' >"$work/expected"
cmp "$work/expected" "$work/round_ab" || fail 'second round-robin piece'
printf 'three\nsix\n' >"$work/expected"
cmp "$work/expected" "$work/round_ac" || fail 'third round-robin piece'
echo 'standard split: concurrent child pipes, round-robin data and EOF cleanup pass'

"$split_binary" -l 2 --filter='exit 7' "$work/input" "$work/failure_" 2>"$work/error"
status=$?
[ "$status" -eq 7 ] || fail "filter status $status"
grep 'exit 7 from command' "$work/error" || fail 'filter diagnostic'
SHELL=/definitely-missing-split-shell "$split_binary" -l 2 --filter='cat' \
  "$work/input" "$work/noexec_" 2>"$work/error"
status=$?
[ "$status" -eq 1 ] || fail "exec failure status $status"
grep 'failed to run command' "$work/error" || fail 'exec diagnostic'
echo 'standard split: nonzero child and failed shell exec propagate through wait pass'

# shellcheck disable=SC2016 # FILE is expanded by the filter shell.
"$split_binary" -l 6 --filter='cat > "$FILE"' "$work/input" "$work/recovered_" || fail 'recovery filter'
cmp "$work/input" "$work/recovered_aa" || fail 'recovery contents'
rm -rf "$work" || fail 'filesystem cleanup'
trap - 0
echo 'standard split: later fork and filesystem cleanup recover pass'
echo '::vm-test::pass'
if [ "${SPLIT_NATIVE_TEST:-0}" != 1 ]; then
  while :; do sleep 1; done
fi
