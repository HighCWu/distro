# net/af_unix (msg_oob): exercises AF_UNIX and TCP loopback MSG_OOB,
# SO_OOBINLINE, SIOCATMARK, EPOLLPRI, and FIOSETOWN/SIGURG signalfd semantics
# across 48 TAP cases (peek and no_peek variants) via kselftest_harness with
# KSELFTEST_HARNESS_NO_FORK.
{
  dir = "tools/testing/selftests/net/af_unix";
  binaries = [ "msg_oob" ];
  userCFlags = "-DKSELFTEST_HARNESS_NO_FORK";
  run = ./msg-oob-test.sh;
}
