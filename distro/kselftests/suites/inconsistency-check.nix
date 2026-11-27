{
  dir = "tools/testing/selftests/timers";
  binaries = [ "inconsistency-check" ];
  run = ./inconsistency-check-test.sh;
}
