#!/bin/busybox sh

# Runs all 9 TAP cases in tools/testing/selftests/net/af_unix/unix_connreset
# (STREAM/DGRAM/SEQPACKET x eof/unread/embryo) compiled with
# -DKSELFTEST_HARNESS_NO_FORK.
#
# Remaining net/af_unix binaries are held out:
#   * diag_uid, scm_rights, unix_connect - unshare(CLONE_NEWUSER/CLONE_NEWNET)
#   * scm_pidfd, so_peek_off             - fork() / mmap()
#   * scm_inq                            - uses SO_INQ/SCM_INQ from glibc sys/socket.h

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

mount -t proc proc /proc || fail "mounting proc failed"
/vm-test-setup-dev-fd || fail "creating /dev/fd links failed"

out=$(unix_connreset 2>&1)
rc=$?
printf '%s\n' "$out"
[ "$rc" -eq 0 ] || fail "unix_connreset exited $rc"
echo "$out" | grep -q '^1\.\.9$' || fail "unix_connreset reported an unexpected TAP plan"
echo "$out" | grep -Eq '^not ok|#[[:space:]]*SKIP|FAIL' && fail "unix_connreset reported a failure or skip"
[ "$(echo "$out" | grep -c '^ok [0-9]')" -eq 9 ] || fail "unix_connreset did not pass all nine tests"

echo "::vm-test::pass"
while :; do :; done
