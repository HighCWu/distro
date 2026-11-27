{
  dir = "tools/testing/selftests/proc";
  binaries = [ "proc-self-isnt-kthread" ];
  run = ./proc-self-isnt-kthread-test.sh;
}
