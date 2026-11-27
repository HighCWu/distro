#!/bin/busybox sh

# Runs the forkless, mmap-free, namespace-free subset of proc kselftests:
#   * fd-001-lookup     - unshare(CLONE_FILES), /proc/self/fd dir & lstat checks
#   * fd-002-posix-eq   - /proc/self/fd vs /proc/<pid>/fd st_dev/st_ino identity
#   * proc-uptime-001   - /proc/uptime vs CLOCK_BOOTTIME monotonicity
#   * proc-net-dev-lseek- /proc/net/dev lseek(0, SEEK_SET) repeatability
#   * self              - /proc/self readlink matches /proc/<pid>
#
# Remaining proc binaries (e.g. proc-loadavg-001, thread-self, proc-pidns,
# proc-pid-vm) are held out because they require fork(), mmap(), namespaces,
# or MMU-backed VM maps.

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

mount -t proc proc /proc || fail "mounting proc failed"
/vm-test-setup-dev-fd || fail "creating /dev/fd links failed"

for bin in fd-001-lookup fd-002-posix-eq proc-uptime-001 proc-net-dev-lseek self; do
  out=$("$bin" 2>&1)
  rc=$?
  [ -n "$out" ] && printf '%s\n' "$out"
  [ "$rc" -eq 0 ] || fail "$bin exited $rc"
  echo "$out" | grep -Eq '^not ok|#[[:space:]]*SKIP|FAIL' && fail "$bin reported a failure or skip"
done

echo "::vm-test::pass"
while :; do :; done
