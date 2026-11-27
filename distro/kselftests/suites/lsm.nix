# lsm (lsm_get_self_attr_test, lsm_set_self_attr_test): exercises the
# lsm_get_self_attr(2), lsm_set_self_attr(2), and lsm_list_modules(2) syscalls
# (CONFIG_SECURITY=y, CONFIG_SECURITY_LANDLOCK=y) across 10 TAP cases via
# kselftest_harness with KSELFTEST_HARNESS_NO_FORK.
{
  dir = "tools/testing/selftests/lsm";
  binaries = [
    "lsm_get_self_attr_test"
    "lsm_set_self_attr_test"
  ];
  userCFlags = "-DKSELFTEST_HARNESS_NO_FORK";
  run = ./lsm-test.sh;
}
