# proc (proc-multiple-procfs, fd-003-kthread): exercises independent procfs
# superblock mounts (hidepid=1 vs hidepid=2 distinct st_dev) and kernel-thread
# /proc/2/fd emptiness without fork, mmap, or namespaces.
{
  dir = "tools/testing/selftests/proc";
  binaries = [
    "proc-multiple-procfs"
    "fd-003-kthread"
  ];
  run = ./proc-multiple-procfs-test.sh;
}
