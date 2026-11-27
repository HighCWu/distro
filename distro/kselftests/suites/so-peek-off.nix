{
  dir = "tools/testing/selftests/net/af_unix";
  binaries = [ "so_peek_off" ];
  userCFlags = "-DKSELFTEST_HARNESS_NO_FORK -DSO_RCVTIMEO_NEW=66 -D'close_range(a,b,c)=((void)(c),close(a),close(b))'";
  run = ./so-peek-off-test.sh;
}
