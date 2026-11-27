# epoll-wakeup: exercises epoll_create/epoll_ctl/epoll_wait/epoll_pwait2,
# eventfd/socketpair edge & level-triggered multi-thread wakeups under
# KSELFTEST_HARNESS_NO_FORK, excluding epoll61 (1000x 11ms race loop),
# with zero fork/vfork/mmap/SKIP.
{
  dir = "tools/testing/selftests/filesystems/epoll";
  binaries = [ "epoll_wakeup_test" ];
  userCFlags = "-DKSELFTEST_HARNESS_NO_FORK";
  run = ./epoll-wakeup-test.sh;
}
