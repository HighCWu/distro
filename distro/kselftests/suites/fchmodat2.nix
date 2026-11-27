# fchmodat2: the syscall is always compiled in (no config gate). fchmodat2_test
# exercises fchmodat2 on regular files and symlinks (including
# AT_SYMLINK_NOFOLLOW) with plain syscalls and no fork, mmap, or namespaces.
{
  dir = "tools/testing/selftests/fchmodat2";
  binaries = [ "fchmodat2_test" ];
  run = ./fchmodat2-test.sh;
}
