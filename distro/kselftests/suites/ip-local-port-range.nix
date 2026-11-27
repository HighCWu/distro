{
  dir = "tools/testing/selftests/net";
  binaries = [ "ip_local_port_range" ];
  userCFlags = "-DKSELFTEST_HARNESS_NO_FORK";
  run = ./ip-local-port-range-test.sh;
}
