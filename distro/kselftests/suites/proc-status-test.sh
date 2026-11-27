#!/bin/busybox sh

# Runs proc-self-isnt-kthread and proc-self-wchan verifying /proc/self/status
# Kthread: 0 and /proc/self/wchan (CONFIG_KALLSYMS=y) with zero skips.

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

mount -t proc proc /proc || fail "mounting proc failed"
/vm-test-setup-dev-fd || fail "creating /dev/fd links failed"

for bin in proc-self-isnt-kthread proc-self-wchan; do
  out=$("$bin" 2>&1)
  rc=$?
  [ -n "$out" ] && printf '%s\n' "$out"
  [ "$rc" -eq 0 ] || fail "$bin exited $rc"
  echo "$out" | grep -Eq '^not ok|#[[:space:]]*SKIP|FAIL' && fail "$bin reported a failure or skip"
done

echo "::vm-test::pass"
while :; do :; done
