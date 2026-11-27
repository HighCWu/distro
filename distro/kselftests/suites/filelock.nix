# filelock: exercises Open File Description locks (F_OFD_SETLK / F_OFD_GETLK /
# F_UNLCK) across independent open file descriptions without fork, mmap, or
# namespaces.
{
  dir = "tools/testing/selftests/filelock";
  binaries = [ "ofdlocks" ];
  run = ./filelock-test.sh;
}
