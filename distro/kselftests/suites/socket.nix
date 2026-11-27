{
  dir = "tools/testing/selftests/net";
  binaries = [ "socket" ];
  userCFlags = "-Wno-int-conversion";
  run = ./socket-test.sh;
}
