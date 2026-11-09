#!/bin/busybox sh
# shellcheck shell=sh
# SPDX-License-Identifier: MIT

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export LC_ALL=C

tar_program=${TAR_FORK_PROGRAM:-/bin/tar}
helper=${TAR_FORK_HELPER:-/bin/tar-fork-helper}
native_reference=${NATIVE_REFERENCE:-0}
workdir=

cleanup() {
  if [ -n "$workdir" ]; then
    rm -rf "$workdir"
  fi
}

fail() {
  printf 'tar fork runtime failure: %s\n' "$*" >&2
  if [ -n "$workdir" ] && [ -d "$workdir" ]; then
    for error_log in "$workdir"/*.err; do
      if [ -f "$error_log" ] && [ -s "$error_log" ]; then
        printf 'tar fork diagnostic (%s):\n' "${error_log##*/}" >&2
        tail -n 20 "$error_log" >&2
      fi
    done
  fi
  cleanup
  workdir=
  if [ "$native_reference" = 1 ]; then
    exit 1
  fi
  echo '::vm-test::fail'
  while :; do sleep 1; done
}

trap cleanup EXIT

if [ "$native_reference" != 1 ]; then
  mount -t devtmpfs devtmpfs /dev >/dev/null 2>&1
  status=$?
  [ "$status" -eq 0 ] || fail "mount devtmpfs on /dev (status $status)"
  mount -t proc proc /proc >/dev/null 2>&1
  status=$?
  [ "$status" -eq 0 ] || fail "mount proc on /proc (status $status)"
fi

[ -x "$tar_program" ] || fail "tar is not executable: $tar_program"
[ -x "$helper" ] || fail "helper is not executable: $helper"

workdir=$(mktemp -d /tmp/tar-fork-runtime.XXXXXX)
mktemp_status=$?
[ "$mktemp_status" -eq 0 ] || fail "could not create temporary directory"
[ -n "$workdir" ] || fail "could not create temporary directory"

quote_path() {
  case "$1" in
  *"'"*) return 1 ;;
  esac
  printf "'%s'" "$1"
}

quoted_helper=$(quote_path "$helper")
quote_status=$?
[ "$quote_status" -eq 0 ] || fail "helper path contains an unsupported single quote"
filter_command="$quoted_helper filter"
member_command="$quoted_helper member"
checkpoint_command="$quoted_helper checkpoint"

mkdir -p "$workdir/source/src" "$workdir/out-regular"
status=$?
[ "$status" -eq 0 ] || fail "create temporary source directories"
printf 'regular filter round trip\n' >"$workdir/source/src/regular.txt"
status=$?
[ "$status" -eq 0 ] || fail "write regular source file"
printf 'stream filter round trip\n' >"$workdir/source/src/stream.txt"
status=$?
[ "$status" -eq 0 ] || fail "write stream source file"
printf 'member bytes preserved with spaces\n' >"$workdir/source/src/member with spaces.txt"
status=$?
[ "$status" -eq 0 ] || fail "write to-command source file"

# A regular-file archive exercises the ordinary GNU tar compressor/decompressor
# children and confirms the filter preserves a complete tar stream.
filter_log=$workdir/filter.log
regular_archive=$workdir/regular.tar
if TAR_FORK_LOG="$filter_log" "$tar_program" \
  --use-compress-program="$filter_command" \
  -cf "$regular_archive" -C "$workdir/source" src \
  >"$workdir/regular-create.out" 2>"$workdir/regular-create.err"; then
  :
else
  status=$?
  fail "regular archive create through external filter (status $status)"
fi
if TAR_FORK_LOG="$filter_log" "$tar_program" \
  --use-compress-program="$filter_command" \
  -xf "$regular_archive" -C "$workdir/out-regular" \
  >"$workdir/regular-extract.out" 2>"$workdir/regular-extract.err"; then
  :
else
  status=$?
  fail "regular archive extract through external filter (status $status)"
fi
cmp "$workdir/source/src/regular.txt" "$workdir/out-regular/src/regular.txt" \
  >"$workdir/regular-cmp.out" 2>&1
status=$?
[ "$status" -eq 0 ] || fail "regular filter round-trip bytes differ"
grep -Eq '^filter pid=[0-9]+ ppid=[0-9]+ direction=compress$' "$filter_log"
status=$?
[ "$status" -eq 0 ] || fail "compress filter did not report its process"
grep -Eq '^filter pid=[0-9]+ ppid=[0-9]+ direction=decompress$' "$filter_log"
status=$?
[ "$status" -eq 0 ] || fail "decompress filter did not report its process"
echo 'tar fork: external filter regular archive round-trip pass'

# Use tar's stdout and stdin archive forms so both compressor and decompressor
# run on nonseekable pipes.  Save the first pipeline command's status in a file;
# hush reports only the last command's status for a pipeline.
stream_log=$workdir/stream.log
stream_archive=$workdir/stream.tar
create_status_file=$workdir/stream-create.status
(
  TAR_FORK_LOG="$stream_log" "$tar_program" \
    --use-compress-program="$filter_command" \
    -cf - -C "$workdir/source" src
  tar_status=$?
  printf '%s\n' "$tar_status" >"$create_status_file"
  write_status=$?
  [ "$write_status" -eq 0 ] || exit 125
  exit "$tar_status"
) 2>"$workdir/stream-create.err" | cat >"$stream_archive"
pipe_status=$?
[ "$pipe_status" -eq 0 ] || fail "pipe consumer for tar stdout failed (status $pipe_status)"
[ -s "$create_status_file" ] || fail "tar stdout stage did not record tar's status"
create_status=$(cat "$create_status_file")
status=$?
[ "$status" -eq 0 ] || fail "read tar stdout status"
[ "$create_status" -eq 0 ] || fail "tar create to stdout failed (status $create_status)"

mkdir -p "$workdir/out-stream"
status=$?
[ "$status" -eq 0 ] || fail "create stream extraction directory"
list_status_file=$workdir/stream-list-input.status
(
  cat "$stream_archive"
  cat_status=$?
  printf '%s\n' "$cat_status" >"$list_status_file"
  write_status=$?
  [ "$write_status" -eq 0 ] || exit 125
  exit "$cat_status"
) 2>"$workdir/stream-list-input.err" |
  TAR_FORK_LOG="$stream_log" "$tar_program" \
    --use-compress-program="$filter_command" -tf - \
    >"$workdir/stream.list" 2>"$workdir/stream-list.err"
list_tar_status=$?
[ "$list_tar_status" -eq 0 ] || fail "tar list from pipe failed (status $list_tar_status)"
[ -s "$list_status_file" ] || fail "tar list input did not record cat's status"
list_input_status=$(cat "$list_status_file")
status=$?
[ "$status" -eq 0 ] || fail "read tar list input status"
[ "$list_input_status" -eq 0 ] || fail "pipe writer for tar list failed (status $list_input_status)"
grep -qx 'src/stream.txt' "$workdir/stream.list"
status=$?
[ "$status" -eq 0 ] || fail "tar list from pipe omitted stream member"

extract_status_file=$workdir/stream-extract-input.status
(
  cat "$stream_archive"
  cat_status=$?
  printf '%s\n' "$cat_status" >"$extract_status_file"
  write_status=$?
  [ "$write_status" -eq 0 ] || exit 125
  exit "$cat_status"
) 2>"$workdir/stream-extract-input.err" |
  TAR_FORK_LOG="$stream_log" "$tar_program" \
    --use-compress-program="$filter_command" -xf - -C "$workdir/out-stream" \
    2>"$workdir/stream-extract.err"
extract_tar_status=$?
[ "$extract_tar_status" -eq 0 ] || fail "tar extract from pipe failed (status $extract_tar_status)"
[ -s "$extract_status_file" ] || fail "tar extract input did not record cat's status"
extract_input_status=$(cat "$extract_status_file")
status=$?
[ "$status" -eq 0 ] || fail "read tar extract input status"
[ "$extract_input_status" -eq 0 ] || fail "pipe writer for tar extract failed (status $extract_input_status)"
cmp "$workdir/source/src/stream.txt" "$workdir/out-stream/src/stream.txt" \
  >"$workdir/stream-cmp.out" 2>&1
status=$?
[ "$status" -eq 0 ] || fail "nonseekable filter round-trip bytes differ"
compress_count=$(awk '$1 == "filter" && $4 == "direction=compress" { n++ } END { print n + 0 }' "$stream_log")
status=$?
[ "$status" -eq 0 ] || fail "count stream compressor processes"
[ "$compress_count" -ge 1 ] || fail "stream compressor process was not recorded"
decompress_count=$(awk '$1 == "filter" && $4 == "direction=decompress" { n++ } END { print n + 0 }' "$stream_log")
status=$?
[ "$status" -eq 0 ] || fail "count stream decompressor processes"
[ "$decompress_count" -ge 2 ] || fail "stream decompressor processes were not recorded"
echo 'tar fork: nonseekable pipe archive create, list and extract pass'

# GNU tar supplies per-member metadata to --to-command only in its child.  A
# later checkpoint child must not inherit TAR_FILENAME from that extraction.
member_archive=$workdir/member.tar
member_log=$workdir/member.log
member_data=$workdir/member.data
member_size=$(wc -c <"$workdir/source/src/member with spaces.txt" | tr -d '[:space:]')
status=$?
[ "$status" -eq 0 ] || fail "calculate member size"
[ -n "$member_size" ] || fail "calculate member size"
if "$tar_program" --blocking-factor=1 -cf "$member_archive" -C "$workdir/source" \
  "src/member with spaces.txt" >"$workdir/member-create.out" 2>"$workdir/member-create.err"; then
  :
else
  status=$?
  fail "create to-command archive (status $status)"
fi
if TAR_FORK_LOG="$member_log" TAR_FORK_DATA="$member_data" "$tar_program" \
  --blocking-factor=1 \
  -xf "$member_archive" \
  --to-command="$member_command" \
  --checkpoint=1 \
  --checkpoint-action=exec="$checkpoint_command" \
  "src/member with spaces.txt" \
  >"$workdir/member-extract.out" 2>"$workdir/member-extract.err"; then
  :
else
  status=$?
  fail "to-command extraction and checkpoint (status $status)"
fi
cmp "$workdir/source/src/member with spaces.txt" "$member_data" \
  >"$workdir/member-cmp.out" 2>&1
status=$?
[ "$status" -eq 0 ] || fail "to-command member bytes differ"
grep -F "filename=src/member with spaces.txt size=$member_size type=f" "$member_log" >/dev/null
status=$?
[ "$status" -eq 0 ] || fail "to-command did not receive exact filename, size and type"
grep -Eq '^checkpoint pid=[0-9]+ ppid=[0-9]+ filename=unset checkpoint=[0-9]+$' "$member_log"
status=$?
[ "$status" -eq 0 ] || fail "checkpoint child inherited to-command member environment"
awk '
  $1 == "member" { member_seen = 1 }
  $1 == "checkpoint" && member_seen && $4 == "filename=unset" { checkpoint_after = 1 }
  END { if (!member_seen || !checkpoint_after) exit 1 }
' "$member_log"
status=$?
[ "$status" -eq 0 ] || fail "checkpoint did not run after the member child"
awk -v caller="$$" '
  $1 ~ /^(filter|filter-fail|member|checkpoint)$/ {
    split($2, pid, "=")
    split($3, ppid, "=")
    if (pid[1] != "pid" || ppid[1] != "ppid" ||
        pid[2] !~ /^[0-9]+$/ || ppid[2] !~ /^[0-9]+$/ ||
        pid[2] == ppid[2] || pid[2] == caller || ppid[2] == caller)
      bad = 1
    seen++
  }
  END { if (!seen || bad) exit 1 }
' "$member_log"
status=$?
[ "$status" -eq 0 ] || fail "helper did not report distinct child process identities"
echo 'tar fork: to-command metadata, exact member bytes and parent environment isolation pass'

# A filter that emits the complete archive but exits nonzero must still make
# tar fail.  A missing executable must fail too, and a later ordinary archive
# operation must remain usable in this process.
failure_log=$workdir/failure.log
filter_fail_command="$quoted_helper filter-fail"
TAR_FORK_LOG="$failure_log" "$tar_program" \
  --use-compress-program="$filter_fail_command" \
  -cf "$workdir/filter-fail.tar" -C "$workdir/source" src \
  >"$workdir/filter-fail.out" 2>"$workdir/filter-fail.err"
filter_fail_status=$?
if [ "$filter_fail_status" -eq 0 ]; then
  fail "tar accepted a nonzero external filter"
fi
[ "$filter_fail_status" -ne 0 ] || fail "nonzero filter status was ignored"
grep -Eq '^filter-fail pid=[0-9]+ ppid=[0-9]+ direction=compress$' "$failure_log"
status=$?
[ "$status" -eq 0 ] || fail "nonzero filter helper did not run"

missing_helper=$workdir/no-such-filter
quoted_missing=$(quote_path "$missing_helper")
status=$?
[ "$status" -eq 0 ] || fail "quote missing filter path"
"$tar_program" --use-compress-program="$quoted_missing" \
  -cf "$workdir/missing-filter.tar" -C "$workdir/source" src \
  >"$workdir/missing-filter.out" 2>"$workdir/missing-filter.err"
missing_filter_status=$?
if [ "$missing_filter_status" -eq 0 ]; then
  fail "tar accepted a nonexistent external filter"
fi
[ "$missing_filter_status" -ne 0 ] || fail "missing filter command status was ignored"

mkdir -p "$workdir/out-recovery"
status=$?
[ "$status" -eq 0 ] || fail "create recovery extraction directory"
if "$tar_program" -cf "$workdir/recovery.tar" -C "$workdir/source" src \
  >"$workdir/recovery-create.out" 2>"$workdir/recovery-create.err"; then
  :
else
  status=$?
  fail "ordinary archive create after filter failures (status $status)"
fi
if "$tar_program" -xf "$workdir/recovery.tar" -C "$workdir/out-recovery" \
  >"$workdir/recovery-extract.out" 2>"$workdir/recovery-extract.err"; then
  :
else
  status=$?
  fail "ordinary archive extract after filter failures (status $status)"
fi
cmp "$workdir/source/src/regular.txt" "$workdir/out-recovery/src/regular.txt" \
  >"$workdir/recovery-cmp.out" 2>&1
status=$?
[ "$status" -eq 0 ] || fail "ordinary archive recovery bytes differ"
echo 'tar fork: failed filters return errors and later ordinary archive recovers pass'

rm -rf "$workdir"
status=$?
[ "$status" -eq 0 ] || fail "remove temporary test directory"
workdir=
trap - EXIT
echo '::vm-test::pass'
if [ "$native_reference" = 1 ]; then
  exit 0
fi
while :; do sleep 1; done
