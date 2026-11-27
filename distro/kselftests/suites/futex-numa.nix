{
  dir = "tools/testing/selftests/futex/functional";
  binaries = [ "futex_numa" ];
  run = ./futex-numa-test.sh;
}
