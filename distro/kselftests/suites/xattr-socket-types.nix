# filesystems/xattr (xattr_socket_types_test): exercises user.* xattrs across
# AF_INET, AF_INET6, AF_NETLINK (NETLINK_USERSOCK), AF_PACKET, and abstract
# AF_UNIX sockfs sockets (5 TAP cases) via kselftest_harness with
# KSELFTEST_HARNESS_NO_FORK and no fork, mmap, or namespaces.
{
  dir = "tools/testing/selftests/filesystems/xattr";
  binaries = [ "xattr_socket_types_test" ];
  userCFlags = "-DKSELFTEST_HARNESS_NO_FORK";
  run = ./xattr-socket-types-test.sh;
}
