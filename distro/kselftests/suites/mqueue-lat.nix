{
  dir = "tools/testing/selftests/timers";
  binaries = [ "mqueue-lat" ];
  run = ./mqueue-lat-test.sh;
}
