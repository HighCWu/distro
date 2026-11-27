# net/af_unix (unix_connreset): exercises AF_UNIX EOF and ECONNRESET
# semantics across SOCK_STREAM, SOCK_DGRAM, and SOCK_SEQPACKET via
# kselftest_harness with KSELFTEST_HARNESS_NO_FORK and no fork, mmap, or
# namespaces.
{
  dir = "tools/testing/selftests/net/af_unix";
  binaries = [ "unix_connreset" ];
  userCFlags = "-DKSELFTEST_HARNESS_NO_FORK";
  run = ./af-unix-test.sh;
}
