{
  dir = "tools/testing/selftests/net/af_unix";
  binaries = [ "scm_inq" ];
  userCFlags = "-DKSELFTEST_HARNESS_NO_FORK -DSO_INQ=84 -DSCM_INQ=84";
  run = ./scm-inq-test.sh;
}
