{
  dir = "tools/testing/selftests/net";
  binaries = [ "sk_so_peek_off" ];
  run = ./sk-so-peek-off-test.sh;
}
