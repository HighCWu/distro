{
  dir = "tools/testing/selftests/proc";
  binaries = [ "proc-self-wchan" ];
  run = ./proc-self-wchan-test.sh;
}
