# filesystems (kernfs_test): exercises flistxattr() and fgetxattr() (ENODATA)
# on sysfs/kernfs (/sys/kernel/warn_count) across 2 TAP cases via
# kselftest_harness with KSELFTEST_HARNESS_NO_FORK and no fork, mmap, or
# namespaces.
{
  dir = "tools/testing/selftests/filesystems";
  binaries = [ "kernfs_test" ];
  userCFlags = "-DKSELFTEST_HARNESS_NO_FORK";
  run = ./kernfs-test.sh;
}
