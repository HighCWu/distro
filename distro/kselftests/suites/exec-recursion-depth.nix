# exec-recursion-depth: exercises binfmt_script self-referential #! interpreter
# recursion limit (execve ELOOP) in an unshared mount namespace on ramfs,
# with zero fork/vfork/mmap/SKIP.
{
  dir = "tools/testing/selftests/exec";
  binaries = [ "recursion-depth" ];
  userCFlags = "-D_GNU_SOURCE";
  makeFlags = [ "LDLIBS=" ];
  run = ./exec-recursion-depth-test.sh;
}
