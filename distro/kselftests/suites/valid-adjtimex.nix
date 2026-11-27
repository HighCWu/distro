# valid-adjtimex: exercises adjtimex(ADJ_FREQUENCY) clamping/validation and
# clock_adjtime(CLOCK_REALTIME, ADJ_SETOFFSET) with ADJ_NANO/usec offsets,
# zero fork/vfork/mmap/SKIP and no wall-clock latency thresholds.
{
  dir = "tools/testing/selftests/timers";
  binaries = [ "valid-adjtimex" ];
  run = ./valid-adjtimex-test.sh;
}
