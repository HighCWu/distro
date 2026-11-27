{
  dir = "tools/testing/selftests/net";
  binaries = [ "so_netns_cookie" ];
  run = ./so-netns-cookie-test.sh;
}
