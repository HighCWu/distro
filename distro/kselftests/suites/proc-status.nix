# proc (proc-self-isnt-kthread, proc-self-wchan): exercises /proc/self/status
# Kthread: 0 flag and /proc/self/wchan (CONFIG_KALLSYMS=y) without fork,
# mmap, or namespaces.
{
  dir = "tools/testing/selftests/proc";
  binaries = [
    "proc-self-isnt-kthread"
    "proc-self-wchan"
  ];
  run = ./proc-status-test.sh;
}
