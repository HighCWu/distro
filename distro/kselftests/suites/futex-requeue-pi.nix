# futex-requeue-pi: exercises FUTEX_WAIT_REQUEUE_PI, FUTEX_CMP_REQUEUE_PI,
# FUTEX_LOCK_PI, and FUTEX_UNLOCK_PI across broadcast/owner/locked/timeout
# variants under KSELFTEST_HARNESS_NO_FORK, with zero fork/vfork/mmap/SKIP.
{
  dir = "tools/testing/selftests/futex/functional";
  binaries = [ "futex_requeue_pi" ];
  userCFlags = "-DKSELFTEST_HARNESS_NO_FORK";
  run = ./futex-requeue-pi-test.sh;
}
