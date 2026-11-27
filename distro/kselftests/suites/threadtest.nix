{
  dir = "tools/testing/selftests/timers";
  binaries = [ "threadtest" ];
  run = ./threadtest-test.sh;
}
