# proc (read): exercises recursive /proc traversal (fstatfs 0x9fa0, openat,
# fdopendir, lseek, non-blocking read, readlinkat, and sysrq-trigger "h" write)
# without fork, mmap, or namespaces.
{
  dir = "tools/testing/selftests/proc";
  binaries = [ "read" ];
  run = ./proc-read-test.sh;
}
