# filesystems/statmount (listmount_test): exercises listmount(2) forward and
# reverse mount-ID pagination across 2 TAP cases via kselftest_harness with
# KSELFTEST_HARNESS_NO_FORK and no fork, mmap, or namespaces.
# Overriding LDLIBS drops -lcap (unused by listmount_test; statmount_test and
# statmount_test_ns need namespaces and are held out).
{
  dir = "tools/testing/selftests/filesystems/statmount";
  binaries = [ "listmount_test" ];
  makeFlags = [ "LDLIBS=" ];
  userCFlags = "-DKSELFTEST_HARNESS_NO_FORK";
  run = ./listmount-test.sh;
}
