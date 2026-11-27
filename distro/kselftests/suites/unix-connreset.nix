{
  dir = "tools/testing/selftests/net/af_unix";
  binaries = [ "unix_connreset" ];
  userCFlags = "-DKSELFTEST_HARNESS_NO_FORK";
  run = ./unix-connreset-test.sh;
}
