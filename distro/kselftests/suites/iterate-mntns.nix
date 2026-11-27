{
  dir = "tools/testing/selftests/filesystems/nsfs";
  binaries = [ "iterate_mntns" ];
  userCFlags = "-DKSELFTEST_HARNESS_NO_FORK -Wno-error";
  run = ./iterate-mntns-test.sh;
}
