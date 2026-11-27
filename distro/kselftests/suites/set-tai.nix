{
  dir = "tools/testing/selftests/timers";
  binaries = [ "set-tai" ];
  run = ./set-tai-test.sh;
}
