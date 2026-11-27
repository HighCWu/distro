# filesystems/xattr (xattr_sockfs_test): exercises user.* xattr operations
# (fsetxattr/fgetxattr/flistxattr/fremovexattr, flags, and 128-attr / 128KB
# per-inode limits) on AF_UNIX sockfs sockets via kselftest_harness with
# KSELFTEST_HARNESS_NO_FORK and no fork, mmap, or filesystem xattr dependency.
{
  dir = "tools/testing/selftests/filesystems/xattr";
  binaries = [ "xattr_sockfs_test" ];
  userCFlags = "-DKSELFTEST_HARNESS_NO_FORK";
  run = ./xattr-sockfs-test.sh;
}
