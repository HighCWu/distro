# net (bind_timewait): exercises TCP loopback listen/connect/accept/close into
# TIME_WAIT and verifies subsequent bind() without SO_REUSEADDR returns
# EADDRINUSE across 2 TAP cases (INADDR_LOOPBACK and INADDR_ANY) via
# kselftest_harness with KSELFTEST_HARNESS_NO_FORK.
{
  dir = "tools/testing/selftests/net";
  binaries = [ "bind_timewait" ];
  userCFlags = "-DKSELFTEST_HARNESS_NO_FORK";
  run = ./bind-timewait-test.sh;
}
