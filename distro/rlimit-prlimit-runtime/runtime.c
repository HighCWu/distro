#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <unistd.h>

static void require(int ok, const char *what) {
  if (ok) {
    return;
  }
  fprintf(stderr, "rlimit-prlimit-runtime: %s (errno=%d: %s)\n", what, errno,
          strerror(errno));
  exit(1);
}

int main(void) {
  struct rlimit rl_nofile, prl_nofile;
  require(getrlimit(RLIMIT_NOFILE, &rl_nofile) == 0, "getrlimit(NOFILE)");
  require(prlimit(0, RLIMIT_NOFILE, NULL, &prl_nofile) == 0,
          "prlimit(NOFILE)");
  require(rl_nofile.rlim_cur == prl_nofile.rlim_cur &&
              rl_nofile.rlim_max == prl_nofile.rlim_max,
          "getrlimit == prlimit");

  struct rlimit rl_tmp;
  require(prlimit(0, RLIMIT_CORE, NULL, &rl_tmp) == 0, "prlimit(CORE)");
  require(prlimit(0, RLIMIT_DATA, NULL, &rl_tmp) == 0, "prlimit(DATA)");
  require(prlimit(0, RLIMIT_STACK, NULL, &rl_tmp) == 0, "prlimit(STACK)");
  require(prlimit((pid_t)999999, RLIMIT_NOFILE, NULL, &rl_tmp) == -1 &&
              errno == ESRCH,
          "prlimit(999999) ESRCH");

  struct rlimit bad_rl = {.rlim_cur = rl_nofile.rlim_max + 1U,
                          .rlim_max = rl_nofile.rlim_max};
  if (rl_nofile.rlim_max != RLIM_INFINITY) {
    require(prlimit(0, RLIMIT_NOFILE, &bad_rl, NULL) == -1 && errno == EINVAL,
            "cur > max EINVAL");
  }

  int pfd[2];
  require(pipe2(pfd, O_CLOEXEC) == 0, "pipe2");
  int max_fd = pfd[0] > pfd[1] ? pfd[0] : pfd[1];

  struct rlimit tight_nofile = {.rlim_cur = (rlim_t)(max_fd + 3),
                                .rlim_max = rl_nofile.rlim_max};
  struct rlimit saved_nofile;
  require(prlimit(0, RLIMIT_NOFILE, &tight_nofile, &saved_nofile) == 0,
          "prlimit tighten NOFILE");

  int dups[32];
  int ndups = 0;
  int hit_emfile = 0;
  for (int i = 0; i < 32; i++) {
    int d = dup(pfd[0]);
    if (d < 0) {
      require(errno == EMFILE, "dup hit EMFILE");
      hit_emfile = 1;
      break;
    }
    dups[ndups++] = d;
  }
  require(hit_emfile && ndups >= 1, "NOFILE enforced EMFILE");

  for (int i = 0; i < ndups; i++) {
    require(close(dups[i]) == 0, "close dup");
  }
  require(close(pfd[0]) == 0, "close pfd[0]");
  require(close(pfd[1]) == 0, "close pfd[1]");
  require(prlimit(0, RLIMIT_NOFILE, &saved_nofile, NULL) == 0,
          "restore NOFILE");

  require(signal(SIGXFSZ, SIG_IGN) != SIG_ERR, "ignore SIGXFSZ");

  struct rlimit saved_fsize;
  require(getrlimit(RLIMIT_FSIZE, &saved_fsize) == 0, "getrlimit(FSIZE)");
  struct rlimit tight_fsize = {.rlim_cur = 4096U,
                               .rlim_max = saved_fsize.rlim_max};
  require(setrlimit(RLIMIT_FSIZE, &tight_fsize) == 0, "setrlimit(FSIZE=4096)");

  int fd = open("/tmp/rlim_fsize.bin", O_CREAT | O_TRUNC | O_RDWR | O_CLOEXEC,
                0644);
  require(fd >= 0, "open(/tmp/rlim_fsize.bin)");

  char page[4096];
  memset(page, 'R', sizeof(page));
  require(write(fd, page, sizeof(page)) == (ssize_t)sizeof(page),
          "write 4096 within FSIZE");
  char one = 'X';
  require(write(fd, &one, 1) == -1 && errno == EFBIG,
          "write past RLIMIT_FSIZE EFBIG");

  require(close(fd) == 0, "close fsize file");
  require(unlink("/tmp/rlim_fsize.bin") == 0, "unlink fsize file");
  require(setrlimit(RLIMIT_FSIZE, &saved_fsize) == 0, "restore FSIZE");

  printf("rlimit-prlimit-runtime: ok nofile_dups=%d fsize=4096\n", ndups);
  return 0;
}
