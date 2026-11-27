# net (bind_wildcard): exercises IPv4/IPv6 wildcard and loopback bind() conflict
# matrix (plain, SO_REUSEADDR, SO_REUSEPORT, IPV6_V6ONLY) across 132 TAP cases
# via kselftest_harness with KSELFTEST_HARNESS_NO_FORK and no fork, mmap, or
# namespaces.
{
  dir = "tools/testing/selftests/net";
  binaries = [ "bind_wildcard" ];
  userCFlags = "-DKSELFTEST_HARNESS_NO_FORK";
  run = ./bind-wildcard-test.sh;
}
