{
  dir = "tools/testing/selftests/net/af_unix";
  binaries = [ "unix_connect" ];
  userCFlags = "-DKSELFTEST_HARNESS_NO_FORK";
  run = ./unix-connect-test.sh;
}
