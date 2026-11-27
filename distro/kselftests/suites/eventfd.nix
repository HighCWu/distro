# filesystems/eventfd: exercises eventfd2 flags (O_RDWR, O_CLOEXEC, O_NONBLOCK,
# EFD_SEMAPHORE) and counter read/write semantics via kselftest_harness with
# KSELFTEST_HARNESS_NO_FORK and no mmap, threads, or signals.
{
  dir = "tools/testing/selftests/filesystems/eventfd";
  binaries = [ "eventfd_test" ];
  userCFlags = "-DKSELFTEST_HARNESS_NO_FORK";
  run = ./eventfd-test.sh;
}
