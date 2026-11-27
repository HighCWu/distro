# proc (proc-uptime-002): exercises sched_getaffinity / sched_setaffinity
# CPU-affinity iteration alongside /proc/uptime and CLOCK_BOOTTIME
# monotonicity without fork, mmap, or namespaces.
{
  dir = "tools/testing/selftests/proc";
  binaries = [ "proc-uptime-002" ];
  run = ./proc-uptime-cpu-test.sh;
}
