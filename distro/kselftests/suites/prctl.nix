# prctl (set-process-name): exercises prctl(PR_SET_NAME / PR_GET_NAME),
# NULL-pointer EFAULT rejection, and /proc/self/task/<pid>/comm consistency via
# kselftest_harness with KSELFTEST_HARNESS_NO_FORK and no fork, mmap, or
# namespaces.
{
  dir = "tools/testing/selftests/prctl";
  binaries = [ "set-process-name" ];
  userCFlags = "-DKSELFTEST_HARNESS_NO_FORK";
  run = ./prctl-test.sh;
}
