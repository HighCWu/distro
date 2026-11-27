{
  dir = "tools/testing/selftests/proc";
  binaries = [ "fd-003-kthread" ];
  userCFlags = "-D_GNU_SOURCE";
  run = ./fd-003-kthread-test.sh;
}
