{
  dir = "tools/testing/selftests/membarrier";
  binaries = [
    "membarrier_test_single_thread"
    "membarrier_test_multi_thread"
  ];
  run = ./membarrier-test.sh;
}
