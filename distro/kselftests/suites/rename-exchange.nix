{
  dir = "tools/testing/selftests/filesystems/fat";
  binaries = [ "rename_exchange" ];
  run = ./rename-exchange-test.sh;
}
