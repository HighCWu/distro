#define _GNU_SOURCE
#include <errno.h>
#include <linux/cryptouser.h>
#include <linux/netlink.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static uint32_t next_seq = 1;

static void require(int ok, const char *what) {
  if (ok) {
    return;
  }
  fprintf(stderr, "netlink-crypto-runtime: %s (errno=%d: %s)\n", what, errno,
          strerror(errno));
  exit(1);
}

static int query_single_alg(int nl_fd, const char *name,
                            struct crypto_user_alg *out) {
  struct {
    struct nlmsghdr nlh;
    struct crypto_user_alg cru;
  } req;
  memset(&req, 0, sizeof(req));
  req.nlh.nlmsg_len = NLMSG_LENGTH(sizeof(req.cru));
  req.nlh.nlmsg_type = CRYPTO_MSG_GETALG;
  req.nlh.nlmsg_flags = NLM_F_REQUEST;
  req.nlh.nlmsg_seq = next_seq++;
  snprintf(req.cru.cru_name, sizeof(req.cru.cru_name), "%s", name);

  struct sockaddr_nl kernel;
  memset(&kernel, 0, sizeof(kernel));
  kernel.nl_family = AF_NETLINK;
  require(sendto(nl_fd, &req, req.nlh.nlmsg_len, 0,
                 (const struct sockaddr *)&kernel,
                 sizeof(kernel)) == (ssize_t)req.nlh.nlmsg_len,
          "sendto CRYPTO_MSG_GETALG");

  char buf[4096];
  ssize_t n = recv(nl_fd, buf, sizeof(buf), 0);
  require(n >= (ssize_t)sizeof(struct nlmsghdr), "recv CRYPTO_MSG_GETALG");

  const struct nlmsghdr *nlh = (const struct nlmsghdr *)buf;
  require(NLMSG_OK(nlh, (size_t)n), "NLMSG_OK single");
  if (nlh->nlmsg_type == NLMSG_ERROR) {
    const struct nlmsgerr *err = (const struct nlmsgerr *)NLMSG_DATA(nlh);
    return err->error;
  }
  require(nlh->nlmsg_type == CRYPTO_MSG_GETALG, "CRYPTO_MSG_GETALG reply");
  if (out != NULL) {
    memcpy(out, NLMSG_DATA(nlh), sizeof(*out));
  }
  return 0;
}

int main(void) {
  int nl_fd = socket(AF_NETLINK, SOCK_RAW | SOCK_CLOEXEC, NETLINK_CRYPTO);
  require(nl_fd >= 0, "socket(AF_NETLINK, NETLINK_CRYPTO)");

  struct {
    struct nlmsghdr nlh;
    struct crypto_user_alg cru;
  } dump_req;
  memset(&dump_req, 0, sizeof(dump_req));
  dump_req.nlh.nlmsg_len = NLMSG_LENGTH(sizeof(dump_req.cru));
  dump_req.nlh.nlmsg_type = CRYPTO_MSG_GETALG;
  dump_req.nlh.nlmsg_flags = NLM_F_REQUEST | NLM_F_DUMP;
  dump_req.nlh.nlmsg_seq = next_seq++;

  struct sockaddr_nl kernel;
  memset(&kernel, 0, sizeof(kernel));
  kernel.nl_family = AF_NETLINK;
  require(sendto(nl_fd, &dump_req, dump_req.nlh.nlmsg_len, 0,
                 (const struct sockaddr *)&kernel,
                 sizeof(kernel)) == (ssize_t)dump_req.nlh.nlmsg_len,
          "sendto CRYPTO_MSG_GETALG dump");

  int found_sha256 = 0;
  int found_aes = 0;
  int total = 0;
  int done = 0;
  char buf[8192];
  while (!done) {
    ssize_t n = recv(nl_fd, buf, sizeof(buf), 0);
    require(n > 0, "recv CRYPTO_MSG_GETALG dump");
    size_t rem = (size_t)n;
    for (const struct nlmsghdr *nlh = (const struct nlmsghdr *)buf;
         NLMSG_OK(nlh, rem); nlh = NLMSG_NEXT(nlh, rem)) {
      if (nlh->nlmsg_type == NLMSG_DONE) {
        done = 1;
        break;
      }
      require(nlh->nlmsg_type != NLMSG_ERROR, "CRYPTO_MSG_GETALG dump error");
      if (nlh->nlmsg_type != CRYPTO_MSG_GETALG) {
        continue;
      }
      const struct crypto_user_alg *cru =
          (const struct crypto_user_alg *)NLMSG_DATA(nlh);
      total++;
      if (strncmp(cru->cru_name, "sha256", sizeof(cru->cru_name)) == 0) {
        found_sha256 = 1;
      }
      if (strncmp(cru->cru_name, "aes", sizeof(cru->cru_name)) == 0) {
        found_aes = 1;
      }
    }
  }
  require(total > 0 && found_sha256 && found_aes,
          "NETLINK_CRYPTO dump includes sha256 and aes");

  struct crypto_user_alg sha_info;
  memset(&sha_info, 0, sizeof(sha_info));
  require(query_single_alg(nl_fd, "sha256", &sha_info) == 0,
          "query single sha256");
  require(strncmp(sha_info.cru_name, "sha256", sizeof(sha_info.cru_name)) == 0,
          "sha256 cru_name match");

  require(query_single_alg(nl_fd, "nonexistent-wasm-alg", NULL) == -ENOENT,
          "query nonexistent ENOENT");

  require(close(nl_fd) == 0, "close nl_fd");
  printf("netlink-crypto-runtime: ok total=%d drv=%s\n", total,
         sha_info.cru_driver_name);
  return 0;
}
