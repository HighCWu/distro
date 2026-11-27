# proc (proc-fsconfig-hidepid, proc-2-is-kthread): exercises fsopen("proc") /
# fsconfig(FSCONFIG_SET_STRING, "hidepid", ...) validation and kthreadd
# (/proc/2/status Kthread: 1) without fork, mmap, or namespaces.
{
  dir = "tools/testing/selftests/proc";
  binaries = [
    "proc-fsconfig-hidepid"
    "proc-2-is-kthread"
  ];
  run = ./proc-fsconfig-test.sh;
}
