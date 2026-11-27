#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/seccomp.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef SYS_seccomp
#define SYS_seccomp 277
#endif

static void require(int ok, const char *what) {
  if (ok) {
    return;
  }
  fprintf(stderr, "seccomp-strict-runtime: %s (errno=%d: %s)\n", what, errno,
          strerror(errno));
  exit(1);
}

struct strict_ctx {
  int write_fd;
  int prctl_rc;
};

static void *strict_worker(void *arg) {
  struct strict_ctx *ctx = (struct strict_ctx *)arg;
  int rc = prctl(PR_SET_SECCOMP, SECCOMP_MODE_STRICT);
  ctx->prctl_rc = rc;
  if (rc == 0) {
    const char ok[] = "strict-ok";
    ssize_t unused_n = write(ctx->write_fd, ok, sizeof(ok) - 1);
    (void)unused_n;
  }
  syscall(SYS_exit, 0);
  return NULL;
}

int main(void) {
  int mode = prctl(PR_GET_SECCOMP);
  require(mode == SECCOMP_MODE_DISABLED, "PR_GET_SECCOMP disabled");

  uint64_t dummy_prog[2] = {0, 0};
  require(prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, dummy_prog) == -1 &&
              errno == EINVAL,
          "PR_SET_SECCOMP(FILTER) EINVAL");
  require(syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER, 0U, dummy_prog) == -1 &&
              errno == EINVAL,
          "seccomp(SET_MODE_FILTER) EINVAL");

  uint32_t act = SECCOMP_RET_ALLOW;
  require(syscall(SYS_seccomp, SECCOMP_GET_ACTION_AVAIL, 0U, &act) == 0,
          "seccomp(GET_ACTION_AVAIL ALLOW) == 0");
  uint32_t bad_act = 0xdeadbeefU;
  require(syscall(SYS_seccomp, SECCOMP_GET_ACTION_AVAIL, 0U, &bad_act) == -1 &&
              errno == EOPNOTSUPP,
          "seccomp(GET_ACTION_AVAIL invalid) EOPNOTSUPP");

  int pfd[2];
  require(pipe2(pfd, O_CLOEXEC) == 0, "pipe2");

  struct strict_ctx ctx = {.write_fd = pfd[1], .prctl_rc = -1};
  pthread_attr_t attr;
  require(pthread_attr_init(&attr) == 0, "pthread_attr_init");
  require(pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED) == 0,
          "pthread_attr_setdetachstate");

  pthread_t tid;
  require(pthread_create(&tid, &attr, strict_worker, &ctx) == 0,
          "pthread_create");
  pthread_attr_destroy(&attr);

  char buf[16];
  ssize_t n = read(pfd[0], buf, sizeof(buf));
  require(n == 9 && memcmp(buf, "strict-ok", 9) == 0,
          "strict worker write payload");
  require(ctx.prctl_rc == 0, "worker PR_SET_SECCOMP(STRICT) == 0");

  require(close(pfd[0]) == 0, "close pfd[0]");
  require(close(pfd[1]) == 0, "close pfd[1]");

  printf("seccomp-strict-runtime: ok mode=strict filter=EINVAL\n");
  return 0;
}
