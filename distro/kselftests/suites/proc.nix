# proc: exercises /proc/self/fd lookup and POSIX inode identity, /proc/self
# symlink resolution, /proc/uptime monotonicity, and /proc/net/dev lseek
# without fork, mmap, or namespaces.
{
  dir = "tools/testing/selftests/proc";
  binaries = [
    "fd-001-lookup"
    "fd-002-posix-eq"
    "proc-uptime-001"
    "proc-net-dev-lseek"
    "self"
  ];
  userCFlags = "-D_GNU_SOURCE";
  run = ./proc-test.sh;
}
