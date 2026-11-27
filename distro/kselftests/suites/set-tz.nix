{
  dir = "tools/testing/selftests/timers";
  binaries = [ "set-tz" ];
  run = ./set-tz-test.sh;
}
