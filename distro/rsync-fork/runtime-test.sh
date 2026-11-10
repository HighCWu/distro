#!/bin/busybox sh
# shellcheck shell=sh
# SPDX-License-Identifier: MIT

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export LC_ALL=C

rsync_program=${RSYNC_FORK_PROGRAM:-/opt/rsync-fork/bin/rsync}
helper=${RSYNC_FORK_HELPER:-/opt/rsync-fork/libexec/rsync-fork-helper}
native_reference=${NATIVE_REFERENCE:-0}
work=

cleanup() {
  if [ -n "$work" ]; then
    rm -rf "$work"
  fi
}

fail() {
  printf 'rsync fork runtime failure: %s\n' "$*" >&2
  if [ -n "$work" ] && [ -d "$work" ]; then
    for diagnostic in "$work"/*.stdout "$work"/*.stderr "$work"/*.log; do
      if [ -f "$diagnostic" ] && [ -s "$diagnostic" ]; then
        printf 'rsync fork diagnostic (%s):\n' "${diagnostic##*/}" >&2
        tail -n 30 "$diagnostic" >&2
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
  mount -t devtmpfs devtmpfs /dev >/dev/null 2>&1
  status=$?
  [ "$status" -eq 0 ] || fail "mount devtmpfs (status $status)"
  mount -t proc proc /proc >/dev/null 2>&1
  status=$?
  [ "$status" -eq 0 ] || fail "mount proc (status $status)"
  echo 'rsync fork runtime: target wasm candidate'
else
  echo 'rsync fork runtime: native reference'
fi

[ -x "$rsync_program" ] || fail "rsync is not executable: $rsync_program"
[ -x "$helper" ] || fail "helper is not executable: $helper"
[ -r /proc/self/stat ] || fail 'process status is unavailable under /proc'

version=$("$rsync_program" --version 2>&1)
status=$?
[ "$status" -eq 0 ] || fail "rsync --version (status $status)"
case "$version" in
*rsync*) ;;
*) fail 'expected an rsync binary' ;;
esac

work=$(mktemp -d /tmp/rsync-fork-runtime.XXXXXX 2>/dev/null)
status=$?
[ "$status" -eq 0 ] || fail 'creating temporary directory'
[ -n "$work" ] || fail 'creating temporary directory'
trap cleanup 0

source_tree="$work/source"
local_dest="$work/local-destination"
remote_dest="$work/remote-destination"
child_log=$work/remote-children.log
export RSYNC_FORK_PROGRAM="$rsync_program"
export RSYNC_FORK_CHILD_LOG="$child_log"
: >"$child_log"
status=$?
[ "$status" -eq 0 ] || fail 'creating remote child log'

mkdir -p "$source_tree/directory with space"
status=$?
[ "$status" -eq 0 ] || fail 'creating source directories'
printf 'rsync fork preserves names and symlinks\n' \
  >"$source_tree/directory with space/payload with spaces.txt"
status=$?
[ "$status" -eq 0 ] || fail 'writing source file with spaces'
printf 'hard-linked source payload\n' >"$source_tree/hardlink-one"
status=$?
[ "$status" -eq 0 ] || fail 'writing hardlink source'
ln "$source_tree/hardlink-one" "$source_tree/hardlink-two"
status=$?
[ "$status" -eq 0 ] || fail 'creating source hardlink'
ln -s 'directory with space/payload with spaces.txt' \
  "$source_tree/link to spaced file"
status=$?
[ "$status" -eq 0 ] || fail 'creating source symlink'
dd if=/dev/zero of="$source_tree/delta.bin" bs=4096 count=256 \
  2>"$work/create-delta.stderr"
status=$?
[ "$status" -eq 0 ] || fail "creating delta fixture (status $status)"
delta_size=$(wc -c <"$source_tree/delta.bin" | tr -d '[:space:]')
status=$?
[ "$status" -eq 0 ] || fail 'measuring delta fixture'
[ -n "$delta_size" ] || fail 'measuring delta fixture'

run_supervised() {
  stage=$1
  shift
  "$helper" --supervise "$rsync_program" "$@" \
    >"$work/$stage.stdout" 2>"$work/$stage.stderr"
}

remote_child_count() {
  wc -l <"$child_log" | tr -d '[:space:]'
}

check_remote_children_reaped() {
  stage=$1
  previous_count=$2
  current_count=$(remote_child_count)
  status=$?
  [ "$status" -eq 0 ] || fail "$stage: counting remote children"
  [ "$current_count" -gt "$previous_count" ] ||
    fail "$stage did not start the local remote-shell child"

  new_children=$work/$stage.children
  tail -n "+$((previous_count + 1))" "$child_log" >"$new_children"
  status=$?
  [ "$status" -eq 0 ] || fail "$stage: reading remote child records"
  while IFS=' ' read -r kind pid_field ppid_field host_field program_field; do
    [ "$kind" = rsh ] || fail "$stage: invalid remote child record"
    pid=${pid_field#pid=}
    ppid=${ppid_field#ppid=}
    if [ -z "$pid" ] || [ -z "$ppid" ]; then
      fail "$stage: incomplete child record"
    fi
    case "$pid:$ppid" in
    *[!0-9:]* | :* | *:)
      fail "$stage: invalid child process ids"
      ;;
    esac
    [ "$pid" -ne "$ppid" ] || fail "$stage: helper did not run as a child"
    [ "$host_field" = host=localhost ] || fail "$stage: wrong remote host"
    [ "$program_field" = "program=$rsync_program" ] ||
      fail "$stage: remote side used an unexpected rsync"

    process_stat=/proc/$pid/stat
    if [ -r "$process_stat" ]; then
      proc_comm=
      proc_state=
      proc_parent=
      read -r _proc_pid proc_comm proc_state proc_parent _remainder \
        <"$process_stat"
      case "$proc_comm" in
      '(rsync)' | '(rsync-fork-help)')
        fail "$stage left remote process $pid alive (state $proc_state, parent $proc_parent)"
        ;;
      esac
    fi
  done <"$new_children"
}

assert_tree_matches() {
  destination=$1
  label=$2

  cmp "$source_tree/directory with space/payload with spaces.txt" \
    "$destination/directory with space/payload with spaces.txt" \
    >"$work/$label-payload-cmp.stdout" 2>"$work/$label-payload-cmp.stderr"
  status=$?
  [ "$status" -eq 0 ] || fail "$label: payload bytes differ"
  cmp "$source_tree/delta.bin" "$destination/delta.bin" \
    >"$work/$label-delta-cmp.stdout" 2>"$work/$label-delta-cmp.stderr"
  status=$?
  [ "$status" -eq 0 ] || fail "$label: delta-updated bytes differ"

  [ -L "$destination/link to spaced file" ] ||
    fail "$label: symlink was not preserved"
  link_target=$(readlink "$destination/link to spaced file")
  status=$?
  [ "$status" -eq 0 ] || fail "$label: reading symlink target"
  [ "$link_target" = 'directory with space/payload with spaces.txt' ] ||
    fail "$label: symlink target changed"

  first_inode=$(stat -c '%i' "$destination/hardlink-one")
  status=$?
  [ "$status" -eq 0 ] || fail "$label: reading first hardlink inode"
  second_inode=$(stat -c '%i' "$destination/hardlink-two")
  status=$?
  [ "$status" -eq 0 ] || fail "$label: reading second hardlink inode"
  [ "$first_inode" = "$second_inode" ] || fail "$label: hardlink relationship changed"
}

# A plain local transfer uses rsync's local forked sender/receiver and its
# configured socketpair-or-pipe IPC path.
run_supervised local-initial-sync -aH -- "$source_tree/" "$local_dest/"
status=$?
[ "$status" -eq 0 ] || fail "local initial directory sync (status $status)"
echo 'rsync fork: local sender/receiver initial directory sync pass'

# A loopback remote-shell transfer starts a real receiver child through rsync's
# normal RSH pipe path. The helper execs the same target binary as --server.
before=$(remote_child_count)
status=$?
[ "$status" -eq 0 ] || fail 'counting remote children before initial sync'
run_supervised remote-initial-sync -aH \
  --rsh="$helper" --rsync-path="$rsync_program" -- \
  "$source_tree/" "localhost:$remote_dest/"
status=$?
[ "$status" -eq 0 ] || fail "remote initial directory sync (status $status)"
check_remote_children_reaped remote-initial-sync "$before"
assert_tree_matches "$local_dest" local-initial
assert_tree_matches "$remote_dest" remote-initial
echo 'rsync fork: loopback sender/receiver sync preserves files, symlink and hardlinks pass'

# Keep the file size and most blocks unchanged so --stats can prove that the
# sender used the existing destination as a delta basis.
sleep 1
printf 'changed-block!' |
  dd of="$source_tree/delta.bin" bs=1 seek=524288 conv=notrunc \
    2>"$work/update-delta.stderr"
status=$?
[ "$status" -eq 0 ] || fail "changing delta fixture (status $status)"

run_supervised local-delta-update -aH --no-whole-file --stats -- \
  "$source_tree/" "$local_dest/"
status=$?
[ "$status" -eq 0 ] || fail "local delta update (status $status)"

before=$(remote_child_count)
status=$?
[ "$status" -eq 0 ] || fail 'counting remote children before delta update'
run_supervised remote-delta-update -aH --no-whole-file --stats \
  --rsh="$helper" --rsync-path="$rsync_program" -- \
  "$source_tree/" "localhost:$remote_dest/"
status=$?
[ "$status" -eq 0 ] || fail "remote delta update (status $status)"
check_remote_children_reaped remote-delta-update "$before"

for stage in local-delta-update remote-delta-update; do
  cat "$work/$stage.stdout" "$work/$stage.stderr" >"$work/$stage.stats"
  status=$?
  [ "$status" -eq 0 ] || fail "$stage: combining stats output"
  literal=$(sed -n 's/^[[:space:]]*Literal data: \([0-9][0-9,]*\) bytes/\1/p' \
    "$work/$stage.stats" | tr -d ',')
  status=$?
  [ "$status" -eq 0 ] || fail "$stage: reading literal byte count"
  matched=$(sed -n 's/^[[:space:]]*Matched data: \([0-9][0-9,]*\) bytes/\1/p' \
    "$work/$stage.stats" | tr -d ',')
  status=$?
  [ "$status" -eq 0 ] || fail "$stage: reading matched byte count"
  if [ -z "$literal" ] || [ -z "$matched" ]; then
    fail "$stage did not report literal and matched data"
  fi
  [ "$literal" -lt "$delta_size" ] ||
    fail "$stage sent the whole delta fixture ($literal of $delta_size bytes)"
  [ "$matched" -gt 0 ] || fail "$stage did not reuse any existing file data"
done
assert_tree_matches "$local_dest" local-delta
assert_tree_matches "$remote_dest" remote-delta
echo 'rsync fork: existing-file local and remote delta updates pass'

# A receiver error must remain a real rsync failure. The same candidate then
# performs a valid transfer, while the supervisor checks every descendant.
before=$(remote_child_count)
status=$?
[ "$status" -eq 0 ] || fail 'counting remote children before expected failure'
run_supervised remote-error-recovery -aH \
  --rsh="$helper" --rsync-path="$rsync_program" -- \
  "$source_tree/" "localhost:$work/missing-parent/destination/"
failure_status=$?
[ "$failure_status" -eq 11 ] ||
  fail "remote receiver should report rsync file-I/O failure 11, got $failure_status"
grep -F 'mkdir "' "$work/remote-error-recovery.stderr" >/dev/null 2>&1
status=$?
[ "$status" -eq 0 ] || fail 'remote receiver error did not report the failed mkdir'
grep -F 'failed: No such file or directory' \
  "$work/remote-error-recovery.stderr" >/dev/null 2>&1
status=$?
[ "$status" -eq 0 ] || fail 'remote receiver error did not report the missing parent directory'
check_remote_children_reaped remote-error-recovery "$before"
echo 'rsync fork: remote receiver returned file-I/O failure and children were reaped'

before=$(remote_child_count)
status=$?
[ "$status" -eq 0 ] || fail 'counting remote children before recovery'
run_supervised remote-recovery -aH \
  --rsh="$helper" --rsync-path="$rsync_program" -- \
  "$source_tree/" "localhost:$remote_dest/"
status=$?
[ "$status" -eq 0 ] || fail "remote transfer after error (status $status)"
check_remote_children_reaped remote-recovery "$before"
assert_tree_matches "$remote_dest" remote-recovery
echo 'rsync fork: later remote transfer recovered after child failure'

rm -rf "$work"
status=$?
[ "$status" -eq 0 ] || fail 'temporary tree cleanup'
work=
trap - 0
echo '::vm-test::pass'
if [ "$native_reference" = 1 ]; then
  exit 0
fi
while :; do sleep 1; done
