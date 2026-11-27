# net (reuseaddr_ports_exhausted): exercises SO_REUSEADDR / SO_REUSEPORT /
# EUID bind() and listen() conflict rules under an exhausted 1-port ephemeral
# range (32768 32768) across 3 TAP cases via kselftest_harness with
# KSELFTEST_HARNESS_NO_FORK and no fork, mmap, or namespaces.
{
  dir = "tools/testing/selftests/net";
  binaries = [ "reuseaddr_ports_exhausted" ];
  userCFlags = "-DKSELFTEST_HARNESS_NO_FORK";
  run = ./reuseaddr-ports-exhausted-test.sh;
}
