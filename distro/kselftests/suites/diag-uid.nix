{
  dir = "tools/testing/selftests/net/af_unix";
  binaries = [ "diag_uid" ];
  userCFlags = "-DKSELFTEST_HARNESS_NO_FORK";
  run = ./diag-uid-test.sh;
}
