#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <linux/bpf.h>
#include <net/if.h>
#include <netinet/in.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef SYS_bpf
#define SYS_bpf 280
#endif

static void require(int ok, const char *what) {
  if (ok) {
    return;
  }
  fprintf(stderr, "bpf-syscall-runtime: %s (errno=%d: %s)\n", what, errno,
          strerror(errno));
  exit(1);
}

static int sys_bpf(enum bpf_cmd cmd, union bpf_attr *attr, unsigned int size) {
  return (int)syscall(SYS_bpf, cmd, attr, size);
}

static int create_map(uint32_t map_type, uint32_t key_size, uint32_t value_size,
                      uint32_t max_entries) {
  union bpf_attr attr;
  memset(&attr, 0, sizeof(attr));
  attr.map_type = map_type;
  attr.key_size = key_size;
  attr.value_size = value_size;
  attr.max_entries = max_entries;
  int fd = sys_bpf(BPF_MAP_CREATE, &attr, sizeof(attr));
  require(fd >= 0, "BPF_MAP_CREATE");
  return fd;
}

static int map_update(int map_fd, const void *key, const void *val,
                      uint64_t flags) {
  union bpf_attr attr;
  memset(&attr, 0, sizeof(attr));
  attr.map_fd = (uint32_t)map_fd;
  attr.key = (uint64_t)(uintptr_t)key;
  attr.value = (uint64_t)(uintptr_t)val;
  attr.flags = flags;
  return sys_bpf(BPF_MAP_UPDATE_ELEM, &attr, sizeof(attr));
}

static int map_lookup(int map_fd, const void *key, void *val) {
  union bpf_attr attr;
  memset(&attr, 0, sizeof(attr));
  attr.map_fd = (uint32_t)map_fd;
  attr.key = (uint64_t)(uintptr_t)key;
  attr.value = (uint64_t)(uintptr_t)val;
  return sys_bpf(BPF_MAP_LOOKUP_ELEM, &attr, sizeof(attr));
}

static int map_get_next_key(int map_fd, const void *key, void *next_key) {
  union bpf_attr attr;
  memset(&attr, 0, sizeof(attr));
  attr.map_fd = (uint32_t)map_fd;
  attr.key = (uint64_t)(uintptr_t)key;
  attr.next_key = (uint64_t)(uintptr_t)next_key;
  return sys_bpf(BPF_MAP_GET_NEXT_KEY, &attr, sizeof(attr));
}

static int map_delete(int map_fd, const void *key) {
  union bpf_attr attr;
  memset(&attr, 0, sizeof(attr));
  attr.map_fd = (uint32_t)map_fd;
  attr.key = (uint64_t)(uintptr_t)key;
  return sys_bpf(BPF_MAP_DELETE_ELEM, &attr, sizeof(attr));
}

static int load_socket_filter(int32_t ret_imm) {
  struct bpf_insn insns[2] = {
      {.code = BPF_ALU64 | BPF_MOV | BPF_K,
       .dst_reg = BPF_REG_0,
       .src_reg = 0,
       .off = 0,
       .imm = ret_imm},
      {.code = BPF_JMP | BPF_EXIT,
       .dst_reg = 0,
       .src_reg = 0,
       .off = 0,
       .imm = 0},
  };
  union bpf_attr attr;
  memset(&attr, 0, sizeof(attr));
  attr.prog_type = BPF_PROG_TYPE_SOCKET_FILTER;
  attr.insns = (uint64_t)(uintptr_t)insns;
  attr.insn_cnt = 2;
  attr.license = (uint64_t)(uintptr_t)"GPL";
  int fd = sys_bpf(BPF_PROG_LOAD, &attr, sizeof(attr));
  require(fd >= 0, "BPF_PROG_LOAD");
  return fd;
}

static void bring_up_lo(void) {
  int fd = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
  require(fd >= 0, "socket(AF_INET, SOCK_DGRAM)");
  struct ifreq ifr;
  memset(&ifr, 0, sizeof(ifr));
  snprintf(ifr.ifr_name, sizeof(ifr.ifr_name), "lo");
  require(ioctl(fd, SIOCGIFFLAGS, &ifr) == 0, "SIOCGIFFLAGS lo");
  ifr.ifr_flags |= (short)(IFF_UP | IFF_RUNNING);
  require(ioctl(fd, SIOCSIFFLAGS, &ifr) == 0, "SIOCSIFFLAGS lo");
  require(close(fd) == 0, "close ioctl fd");
}

int main(void) {
  int arr_fd = create_map(BPF_MAP_TYPE_ARRAY, 4U, 8U, 4U);
  uint32_t akey = 2U;
  uint64_t aval = 0x1122334455667788ULL;
  uint64_t aout = 0;
  require(map_update(arr_fd, &akey, &aval, BPF_ANY) == 0, "array update");
  require(map_lookup(arr_fd, &akey, &aout) == 0, "array lookup");
  require(aout == aval, "array value match");

  uint32_t next_k = 99U;
  require(map_get_next_key(arr_fd, NULL, &next_k) == 0 && next_k == 0U,
          "array next_key NULL -> 0");
  require(map_get_next_key(arr_fd, &akey, &next_k) == 0 && next_k == 3U,
          "array next_key 2 -> 3");
  uint32_t last_k = 3U;
  require(map_get_next_key(arr_fd, &last_k, &next_k) == -1 && errno == ENOENT,
          "array next_key 3 -> ENOENT");

  int hash_fd = create_map(BPF_MAP_TYPE_HASH, 4U, 8U, 8U);
  uint32_t hkey = 42U;
  uint64_t hval = 0xCAFEBABEDEADBEEFULL;
  uint64_t hout = 0;
  require(map_update(hash_fd, &hkey, &hval, BPF_NOEXIST) == 0, "hash insert");
  require(map_update(hash_fd, &hkey, &hval, BPF_NOEXIST) == -1 &&
              errno == EEXIST,
          "hash BPF_NOEXIST EEXIST");
  require(map_lookup(hash_fd, &hkey, &hout) == 0 && hout == hval,
          "hash lookup match");
  require(map_get_next_key(hash_fd, NULL, &next_k) == 0 && next_k == hkey,
          "hash next_key NULL -> 42");
  require(map_get_next_key(hash_fd, &hkey, &next_k) == -1 && errno == ENOENT,
          "hash next_key 42 -> ENOENT");
  require(map_delete(hash_fd, &hkey) == 0, "hash delete");
  require(map_lookup(hash_fd, &hkey, &hout) == -1 && errno == ENOENT,
          "hash lookup after delete ENOENT");

  int accept_fd = load_socket_filter(0xffff);
  int drop_fd = load_socket_filter(0);

  bring_up_lo();

  int rx_fd = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
  require(rx_fd >= 0, "socket rx_fd");
  struct sockaddr_in rx_addr;
  memset(&rx_addr, 0, sizeof(rx_addr));
  rx_addr.sin_family = AF_INET;
  rx_addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  require(bind(rx_fd, (const struct sockaddr *)&rx_addr, sizeof(rx_addr)) == 0,
          "bind rx_fd");
  socklen_t rlen = sizeof(rx_addr);
  require(getsockname(rx_fd, (struct sockaddr *)&rx_addr, &rlen) == 0,
          "getsockname rx_fd");

  int tx_fd = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
  require(tx_fd >= 0, "socket tx_fd");

  require(setsockopt(rx_fd, SOL_SOCKET, SO_ATTACH_BPF, &accept_fd,
                     sizeof(accept_fd)) == 0,
          "SO_ATTACH_BPF accept");

  char rbuf[32];
  const char p1[] = "bpf-accept";
  require(sendto(tx_fd, p1, sizeof(p1) - 1, 0,
                 (const struct sockaddr *)&rx_addr,
                 sizeof(rx_addr)) == (ssize_t)(sizeof(p1) - 1),
          "sendto accept");
  ssize_t rn = recv(rx_fd, rbuf, sizeof(rbuf), MSG_DONTWAIT);
  require(rn == (ssize_t)(sizeof(p1) - 1) &&
              memcmp(rbuf, p1, sizeof(p1) - 1) == 0,
          "recv under accept filter");

  require(setsockopt(rx_fd, SOL_SOCKET, SO_ATTACH_BPF, &drop_fd,
                     sizeof(drop_fd)) == 0,
          "SO_ATTACH_BPF drop");
  const char p2[] = "bpf-drop";
  require(sendto(tx_fd, p2, sizeof(p2) - 1, 0,
                 (const struct sockaddr *)&rx_addr,
                 sizeof(rx_addr)) == (ssize_t)(sizeof(p2) - 1),
          "sendto drop");
  rn = recv(rx_fd, rbuf, sizeof(rbuf), MSG_DONTWAIT);
  require(rn == -1 && (errno == EAGAIN || errno == EWOULDBLOCK),
          "recv under drop filter EAGAIN");

  int detach_val = 0;
  require(setsockopt(rx_fd, SOL_SOCKET, SO_DETACH_BPF, &detach_val,
                     sizeof(detach_val)) == 0,
          "SO_DETACH_BPF");
  const char p3[] = "bpf-detach";
  require(sendto(tx_fd, p3, sizeof(p3) - 1, 0,
                 (const struct sockaddr *)&rx_addr,
                 sizeof(rx_addr)) == (ssize_t)(sizeof(p3) - 1),
          "sendto after detach");
  rn = recv(rx_fd, rbuf, sizeof(rbuf), MSG_DONTWAIT);
  require(rn == (ssize_t)(sizeof(p3) - 1) &&
              memcmp(rbuf, p3, sizeof(p3) - 1) == 0,
          "recv after detach");

  require(close(tx_fd) == 0, "close tx_fd");
  require(close(rx_fd) == 0, "close rx_fd");
  require(close(accept_fd) == 0, "close accept_fd");
  require(close(drop_fd) == 0, "close drop_fd");
  require(close(arr_fd) == 0, "close arr_fd");
  require(close(hash_fd) == 0, "close hash_fd");

  printf("bpf-syscall-runtime: ok maps=array,hash progs=accept,drop\n");
  return 0;
}
