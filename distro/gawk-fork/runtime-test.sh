#!/bin/busybox sh
# shellcheck shell=sh
# SPDX-License-Identifier: MIT

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export LC_ALL=C

gawk_program=${GAWK_FORK_PROGRAM:-/bin/gawk-fork}
awk_script=${GAWK_FORK_SCRIPT:-/usr/share/gawk-fork/runtime.awk}
native_reference=${NATIVE_REFERENCE:-0}
work=

cleanup() {
  if [ -n "$work" ]; then
    rm -rf "$work"
  fi
}

fail() {
  printf 'gawk-fork runtime failure: %s\n' "$*" >&2
  if [ -n "$work" ] && [ -d "$work" ]; then
    for diagnostic in "$work"/*.stdout "$work"/*.stderr; do
      if [ -f "$diagnostic" ] && [ -s "$diagnostic" ]; then
        printf 'gawk-fork diagnostic (%s):\n' "${diagnostic##*/}" >&2
        tail -n 20 "$diagnostic" >&2
      fi
    done
  fi
  cleanup
  work=
  if [ "$native_reference" = 1 ]; then
    exit 1
  fi
  echo '::vm-test::fail'
  while :; do sleep 1; done
}

if [ "$native_reference" != 1 ]; then
  mount -t devtmpfs devtmpfs /dev >/dev/null 2>&1 || fail 'mount devtmpfs'
  mount -t proc proc /proc >/dev/null 2>&1 || fail 'mount proc'
fi

[ -x "$gawk_program" ] || fail "GNU Awk is not executable: $gawk_program"
[ -r "$awk_script" ] || fail "runtime script is not readable: $awk_script"
version=$("$gawk_program" --version 2>/dev/null)
status=$?
[ "$status" -eq 0 ] || fail "GNU Awk --version failed (status $status)"
case "$version" in
  *"GNU Awk"*) ;;
  *) fail 'expected GNU Awk' ;;
esac

work=$(mktemp -d /tmp/gawk-fork-runtime.XXXXXX 2>/dev/null)
status=$?
[ "$status" -eq 0 ] || fail 'creating temporary directory'
[ -n "$work" ] || fail 'creating temporary directory'
trap cleanup EXIT

cat >"$work/stdin.txt" <<'EOF'
stdin-first
stdin-second
EOF
status=$?
[ "$status" -eq 0 ] || fail 'writing standard input fixture'
cat >"$work/expected.stdout" <<'EOF'
gawk-fork: system status and output content ok
gawk-fork: write pipe fflush/close content ok
gawk-fork: command getline close/reopen content and status ok
gawk-fork: coprocess fflush/close and response content ok
gawk-fork: failed child status and subsequent recovery ok
gawk-fork: standard input and output content ok
EOF
status=$?
[ "$status" -eq 0 ] || fail 'writing expected output'

/bin/busybox timeout 30 "$gawk_program" -v workdir="$work" -f "$awk_script" \
  <"$work/stdin.txt" >"$work/program.stdout" 2>"$work/program.stderr"
status=$?
[ "$status" -eq 0 ] || fail "GNU Awk runtime exited with status $status"
cmp -s "$work/expected.stdout" "$work/program.stdout" ||
  fail 'GNU Awk output did not match the expected phase markers'
[ ! -s "$work/program.stderr" ] || fail 'GNU Awk wrote unexpected diagnostics'

cat "$work/program.stdout"
status=$?
[ "$status" -eq 0 ] || fail 'reading GNU Awk output'
cleanup
work=
trap - EXIT
echo '::vm-test::pass'
if [ "$native_reference" = 1 ]; then
  exit 0
fi
while :; do sleep 1; done
