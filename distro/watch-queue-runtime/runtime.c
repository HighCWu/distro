#define _GNU_SOURCE
#include <errno.h>
#include <linux/keyctl.h>
#include <linux/watch_queue.h>
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef O_NOTIFICATION_PIPE
#define O_NOTIFICATION_PIPE O_EXCL
#endif
#ifndef KEYCTL_WATCH_KEY
#define KEYCTL_WATCH_KEY 32
#endif
#ifndef KEY_SPEC_PROCESS_KEYRING
#define KEY_SPEC_PROCESS_KEYRING -2
#endif
#ifndef SYS_add_key
#define SYS_add_key 217
#endif
#ifndef SYS_keyctl
#define SYS_keyctl 219
#endif

static void require(int ok, const char *what) {
  if (ok) {
    return;
  }
  fprintf(stderr, "watch-queue-runtime: %s (errno=%d: %s)\n", what, errno,
          strerror(errno));
  exit(1);
}

int main(void) {
  int pfd[2];
  require(pipe2(pfd, O_NOTIFICATION_PIPE | O_NONBLOCK | O_CLOEXEC) == 0,
          "pipe2(O_NOTIFICATION_PIPE)");

  require(ioctl(pfd[0], IOC_WATCH_QUEUE_SET_SIZE, 16) == 0,
          "IOC_WATCH_QUEUE_SET_SIZE");

  uint8_t flt_buf[sizeof(struct watch_notification_filter) +
                  sizeof(struct watch_notification_type_filter)];
  memset(flt_buf, 0, sizeof(flt_buf));
  struct watch_notification_filter *flt =
      (struct watch_notification_filter *)flt_buf;
  flt->nr_filters = 1U;
  flt->filters[0].type = WATCH_TYPE_KEY_NOTIFY;
  flt->filters[0].subtype_filter[0] = (1U << NOTIFY_KEY_UPDATED);
  require(ioctl(pfd[0], IOC_WATCH_QUEUE_SET_FILTER, flt) == 0,
          "IOC_WATCH_QUEUE_SET_FILTER");

  uint8_t buf[128];
  require(read(pfd[0], buf, sizeof(buf)) == -1 && errno == EAGAIN,
          "empty watch queue EAGAIN");

  long key_id = syscall(SYS_add_key, "user", "wq-test-key", "v1", (size_t)2,
                        KEY_SPEC_PROCESS_KEYRING);
  require(key_id > 0, "add_key");

  require(syscall(SYS_keyctl, KEYCTL_WATCH_KEY, key_id, pfd[0], 0x42) == 0,
          "KEYCTL_WATCH_KEY attach");
  require(syscall(SYS_keyctl, KEYCTL_UPDATE, key_id, "v2", (size_t)2) == 0,
          "KEYCTL_UPDATE");

  struct pollfd pf = {.fd = pfd[0], .events = POLLIN, .revents = 0};
  int prc = poll(&pf, 1, 2000);
  require(prc == 1 && (pf.revents & POLLIN) != 0, "poll watch queue");

  ssize_t rn = read(pfd[0], buf, sizeof(buf));
  require(rn >= (ssize_t)sizeof(struct key_notification),
          "read key_notification");

  struct key_notification kn;
  memcpy(&kn, buf, sizeof(kn));
  uint32_t wid = (kn.watch.info & WATCH_INFO_ID) >> WATCH_INFO_ID__SHIFT;
  require(kn.watch.type == WATCH_TYPE_KEY_NOTIFY, "type WATCH_TYPE_KEY_NOTIFY");
  require(kn.watch.subtype == NOTIFY_KEY_UPDATED, "subtype NOTIFY_KEY_UPDATED");
  require(wid == 0x42U, "watch id == 0x42");
  require(kn.key_id == (uint32_t)key_id, "key_id match");

  require(syscall(SYS_keyctl, KEYCTL_WATCH_KEY, key_id, pfd[0], -1) == 0,
          "KEYCTL_WATCH_KEY detach");
  require(syscall(SYS_keyctl, KEYCTL_REVOKE, key_id) == 0, "KEYCTL_REVOKE");
  require(close(pfd[0]) == 0, "close pfd[0]");
  require(close(pfd[1]) == 0, "close pfd[1]");

  printf("watch-queue-runtime: ok key=%ld wid=0x%x\n", key_id, wid);
  return 0;
}
