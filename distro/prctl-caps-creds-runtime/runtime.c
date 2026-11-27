#define _GNU_SOURCE
#include <errno.h>
#include <linux/capability.h>
#include <stdio.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

#ifndef PR_SET_NAME
#define PR_SET_NAME 15
#endif
#ifndef PR_GET_NAME
#define PR_GET_NAME 16
#endif
#ifndef PR_GET_DUMPABLE
#define PR_GET_DUMPABLE 3
#endif
#ifndef PR_SET_DUMPABLE
#define PR_SET_DUMPABLE 4
#endif
#ifndef PR_SET_NO_NEW_PRIVS
#define PR_SET_NO_NEW_PRIVS 38
#endif
#ifndef PR_GET_NO_NEW_PRIVS
#define PR_GET_NO_NEW_PRIVS 39
#endif
#ifndef SYS_capget
#define SYS_capget 90
#endif

static int fail_errno(const char *msg) {
  fprintf(stderr, "FAIL: %s: %s (errno=%d)\n", msg, strerror(errno), errno);
  return 1;
}

static int test_prctl(void) {
  char name[16];
  int val;

  if (prctl(PR_SET_NAME, (unsigned long)"wasm-prctl", 0UL, 0UL, 0UL) != 0)
    return fail_errno("prctl(PR_SET_NAME)");

  memset(name, 0, sizeof(name));
  if (prctl(PR_GET_NAME, (unsigned long)name, 0UL, 0UL, 0UL) != 0)
    return fail_errno("prctl(PR_GET_NAME)");
  if (strcmp(name, "wasm-prctl") != 0) {
    fprintf(stderr, "FAIL: PR_GET_NAME got '%s', expected 'wasm-prctl'\n",
            name);
    return 1;
  }

  if (prctl(PR_SET_DUMPABLE, 0UL, 0UL, 0UL, 0UL) != 0)
    return fail_errno("prctl(PR_SET_DUMPABLE, 0)");
  val = prctl(PR_GET_DUMPABLE, 0UL, 0UL, 0UL, 0UL);
  if (val != 0) {
    fprintf(stderr, "FAIL: PR_GET_DUMPABLE=%d, expected 0\n", val);
    return 1;
  }

  if (prctl(PR_SET_DUMPABLE, 1UL, 0UL, 0UL, 0UL) != 0)
    return fail_errno("prctl(PR_SET_DUMPABLE, 1)");
  val = prctl(PR_GET_DUMPABLE, 0UL, 0UL, 0UL, 0UL);
  if (val != 1) {
    fprintf(stderr, "FAIL: PR_GET_DUMPABLE=%d, expected 1\n", val);
    return 1;
  }

  if (prctl(PR_SET_NO_NEW_PRIVS, 1UL, 0UL, 0UL, 0UL) != 0)
    return fail_errno("prctl(PR_SET_NO_NEW_PRIVS, 1)");
  val = prctl(PR_GET_NO_NEW_PRIVS, 0UL, 0UL, 0UL, 0UL);
  if (val != 1) {
    fprintf(stderr, "FAIL: PR_GET_NO_NEW_PRIVS=%d, expected 1\n", val);
    return 1;
  }

  printf("prctl: ok (name=%s dumpable=0->1 no_new_privs=1)\n", name);
  return 0;
}

static int test_creds_and_caps(void) {
  uid_t ruid = 0, euid = 0, suid = 0;
  gid_t rgid = 0, egid = 0, sgid = 0;
  gid_t groups[64];
  int ngroups, nread;
  struct __user_cap_header_struct hdr;
  struct __user_cap_data_struct data[2];

  if (getresuid(&ruid, &euid, &suid) != 0)
    return fail_errno("getresuid");
  if (ruid != getuid() || euid != geteuid() ||
      (suid != ruid && suid != euid)) {
    fprintf(stderr, "FAIL: uid mismatch r=%u e=%u s=%u getuid=%u geteuid=%u\n",
            (unsigned)ruid, (unsigned)euid, (unsigned)suid,
            (unsigned)getuid(), (unsigned)geteuid());
    return 1;
  }

  if (getresgid(&rgid, &egid, &sgid) != 0)
    return fail_errno("getresgid");
  if (rgid != getgid() || egid != getegid() ||
      (sgid != rgid && sgid != egid)) {
    fprintf(stderr, "FAIL: gid mismatch r=%u e=%u s=%u getgid=%u getegid=%u\n",
            (unsigned)rgid, (unsigned)egid, (unsigned)sgid,
            (unsigned)getgid(), (unsigned)getegid());
    return 1;
  }

  ngroups = getgroups(0, NULL);
  if (ngroups < 0)
    return fail_errno("getgroups(0)");
  if (ngroups > (int)(sizeof(groups) / sizeof(groups[0]))) {
    fprintf(stderr, "FAIL: ngroups=%d exceeds buffer\n", ngroups);
    return 1;
  }
  if (ngroups > 0) {
    nread = getgroups(ngroups, groups);
    if (nread != ngroups)
      return fail_errno("getgroups(ngroups)");
  }

  memset(&hdr, 0, sizeof(hdr));
  memset(data, 0, sizeof(data));
  hdr.version = _LINUX_CAPABILITY_VERSION_3;
  hdr.pid = 0;
  if (syscall(SYS_capget, &hdr, data) != 0)
    return fail_errno("syscall(SYS_capget)");

  if ((data[0].effective & ~data[0].permitted) != 0 ||
      (data[1].effective & ~data[1].permitted) != 0) {
    fprintf(stderr,
            "FAIL: effective caps exceed permitted: eff=%08x:%08x perm=%08x:%08x\n",
            data[1].effective, data[0].effective,
            data[1].permitted, data[0].permitted);
    return 1;
  }

  if (euid == 0 && ((data[0].effective | data[1].effective) == 0 ||
                    (data[0].permitted | data[1].permitted) == 0)) {
    fprintf(stderr, "FAIL: root has empty caps eff=%08x:%08x perm=%08x:%08x\n",
            data[1].effective, data[0].effective,
            data[1].permitted, data[0].permitted);
    return 1;
  }

  printf("creds: ok (uid=%u/%u/%u gid=%u/%u/%u ngroups=%d "
         "caps=eff:%08x:%08x perm:%08x:%08x)\n",
         (unsigned)ruid, (unsigned)euid, (unsigned)suid,
         (unsigned)rgid, (unsigned)egid, (unsigned)sgid,
         ngroups,
         data[1].effective, data[0].effective,
         data[1].permitted, data[0].permitted);
  return 0;
}

int main(void) {
  if (test_prctl() != 0)
    return 1;
  if (test_creds_and_caps() != 0)
    return 1;
  printf("prctl-caps-creds-runtime: PASS\n");
  return 0;
}
