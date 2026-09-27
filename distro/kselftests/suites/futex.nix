# futex/functional: selected binaries cover the traditional futex syscall and
# futex_waitv without relying on unsupported mmap, SysV shm, or preemptive
# signal delivery. See futex-test.sh for the remaining exclusions.
{
  dir = "tools/testing/selftests/futex/functional";
  binaries = [
    "futex_requeue_pi_mismatched_ops"
    "futex_wait_timeout"
    "futex_wait_wouldblock"
  ];
  userCFlags = "-DKSELFTEST_HARNESS_NO_FORK";
  run = ./futex-test.sh;
}
