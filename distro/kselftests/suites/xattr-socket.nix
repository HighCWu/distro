# filesystems/xattr (xattr_socket_test): exercises path-based user.* and
# trusted.* xattrs on AF_UNIX SOCK_STREAM / SOCK_DGRAM / SOCK_SEQPACKET sockets
# bound under /tmp (ext4 in installedTest) across 50 TAP cases via
# kselftest_harness with KSELFTEST_HARNESS_NO_FORK.
{
  dir = "tools/testing/selftests/filesystems/xattr";
  binaries = [ "xattr_socket_test" ];
  userCFlags = "-DKSELFTEST_HARNESS_NO_FORK";
  run = ./xattr-socket-test.sh;
}
