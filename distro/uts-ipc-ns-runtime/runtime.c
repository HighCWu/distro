#define _GNU_SOURCE
#include <errno.h>
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ipc.h>
#include <sys/msg.h>
#include <sys/utsname.h>
#include <unistd.h>

static void require(int ok, const char *what) {
  if (ok) {
    return;
  }
  fprintf(stderr, "uts-ipc-ns-runtime: %s (errno=%d: %s)\n", what, errno,
          strerror(errno));
  exit(1);
}

static void read_link_str(const char *path, char *buf, size_t len) {
  ssize_t n = readlink(path, buf, len - 1);
  require(n > 0, path);
  buf[n] = '\0';
}

struct msgbuf_test {
  long mtype;
  char mtext[32];
};

static void msg_roundtrip(int msqid, const char *payload) {
  struct msgbuf_test snd;
  memset(&snd, 0, sizeof(snd));
  snd.mtype = 1;
  size_t plen = strlen(payload);
  require(plen < sizeof(snd.mtext), "payload length");
  memcpy(snd.mtext, payload, plen + 1);
  require(msgsnd(msqid, &snd, plen + 1, 0) == 0, "msgsnd");

  struct msgbuf_test rcv;
  memset(&rcv, 0, sizeof(rcv));
  ssize_t rn = msgrcv(msqid, &rcv, sizeof(rcv.mtext), 1, 0);
  require(rn == (ssize_t)(plen + 1), "msgrcv");
  require(strcmp(rcv.mtext, payload) == 0, "msgrcv payload");
}

int main(void) {
  struct utsname u0;
  require(uname(&u0) == 0, "baseline uname");

  char uts0[128], ipc0[128];
  read_link_str("/proc/self/ns/uts", uts0, sizeof(uts0));
  read_link_str("/proc/self/ns/ipc", ipc0, sizeof(ipc0));

  int old_msqid = msgget(IPC_PRIVATE, IPC_CREAT | 0600);
  require(old_msqid >= 0, "msgget(old_msqid)");
  msg_roundtrip(old_msqid, "ipc-old-msg");

  require(unshare(CLONE_NEWUTS | CLONE_NEWIPC) == 0,
          "unshare(CLONE_NEWUTS | CLONE_NEWIPC)");

  char uts1[128], ipc1[128];
  read_link_str("/proc/self/ns/uts", uts1, sizeof(uts1));
  read_link_str("/proc/self/ns/ipc", ipc1, sizeof(ipc1));
  require(strcmp(uts1, uts0) != 0, "uts namespace inode changed");
  require(strcmp(ipc1, ipc0) != 0, "ipc namespace inode changed");

  require(sethostname("wasm-uts-test", 13) == 0, "sethostname");
  require(setdomainname("wasm.local", 10) == 0, "setdomainname");

  struct utsname u1;
  require(uname(&u1) == 0, "new uname");
  require(strcmp(u1.nodename, "wasm-uts-test") == 0, "uname nodename");
  require(strcmp(u1.domainname, "wasm.local") == 0, "uname domainname");

  struct msqid_ds ds;
  int old_rc = msgctl(old_msqid, IPC_STAT, &ds);
  require(old_rc == -1 && (errno == EINVAL || errno == EIDRM),
          "old_msqid invisible in new ipc ns");

  int new_msqid = msgget(IPC_PRIVATE, IPC_CREAT | 0600);
  require(new_msqid >= 0, "msgget(new_msqid)");
  msg_roundtrip(new_msqid, "ipc-new-msg");
  require(msgctl(new_msqid, IPC_RMID, NULL) == 0, "msgctl(IPC_RMID)");

  printf("uts-ipc-ns-runtime: ok host=%s domain=%s old=%d new=%d\n",
         u1.nodename, u1.domainname, old_msqid, new_msqid);
  return 0;
}
