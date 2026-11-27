# proc (proc-subset-pid): exercises unshare(CLONE_NEWNS), MS_PRIVATE|MS_REC
# rootfs remount, and mount("proc", ..., "subset=pid") verifying that /proc
# exposes only PIDs, self, and thread-self without fork or mmap.
{
  dir = "tools/testing/selftests/proc";
  binaries = [ "proc-subset-pid" ];
  run = ./proc-subset-pid-test.sh;
}
