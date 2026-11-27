{
  dir = "tools/testing/selftests/net/af_unix";
  binaries = [ "scm_rights" ];
  userCFlags = "-DKSELFTEST_HARNESS_NO_FORK -DSO_PASSRIGHTS=83";
  run = ./scm-rights-test.sh;
}
