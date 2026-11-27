# timers: exercises kernel timekeeping and monotonic multi-thread clock
# consistency on CONFIG_MMU=n without fork, mmap, or namespaces.
# threadtest spawns pthreads checking shared timespec monotonicity; valid-adjtimex
# validates adjtimex(ADJ_FREQUENCY) and clock_adjtime(ADJ_SETOFFSET) bounds
# inside the ephemeral VM.
{
  dir = "tools/testing/selftests/timers";
  binaries = [
    "threadtest"
    "valid-adjtimex"
  ];
  run = ./timers-test.sh;
}
