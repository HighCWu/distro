{
  dir = "tools/testing/selftests/proc";
  binaries = [ "proc-2-is-kthread" ];
  run = ./proc-2-is-kthread-test.sh;
}
