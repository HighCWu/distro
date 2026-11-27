#!/bin/busybox sh

# Runs the non-skipping subset of timers kselftests suited for CONFIG_MMU=n:
#   * threadtest -t 2 -n 4 - 4 pthreads checking shared timespec monotonicity
#                            for 2 seconds (bounded for VM test runtime).
#   * valid-adjtimex       - validates adjtimex(ADJ_FREQUENCY) and
#                            clock_adjtime(ADJ_SETOFFSET) acceptance/rejection
#                            inside the disposable test VM.
#
# Remaining timers binaries are held out:
#   * posix_timers / set-timer-lat - rely on preemptive signal delivery during
#                                    blocked syscalls or tight CPU accounting.
#   * nanosleep / nsleep-lat /     - iterate all clockids including alarm/TAI
#     inconsistency-check            clocks that SKIP without an RTC/alarm.
#   * alarmtimer-suspend /         - test suspend/RTC/system-clock hardware paths
#     clocksource-switch / rtcpie    not present on this platform.

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

mount -t proc proc /proc || fail "mounting proc failed"
/vm-test-setup-dev-fd || fail "creating /dev/fd links failed"

run() {
  out=$("$@" 2>&1)
  rc=$?
  printf '%s\n' "$out"
  [ "$rc" -eq 0 ] || fail "$* exited $rc"
  echo "$out" | grep -Eq '^not ok|#[[:space:]]*SKIP|FAIL' && fail "$* reported a failure or skip"
}

run threadtest -t 2 -n 4
run valid-adjtimex

echo "::vm-test::pass"
while :; do :; done
