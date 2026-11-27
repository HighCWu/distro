# splice: exercises splice(2) on /dev/null (default_file_splice_read) and
# /proc/sys vs /proc/self/comm (splice_read) without fork, mmap, or namespaces.
{
  dir = "tools/testing/selftests/splice";
  binaries = [
    "default_file_splice_read"
    "splice_read"
  ];
  run = ./splice-test.sh;
}
