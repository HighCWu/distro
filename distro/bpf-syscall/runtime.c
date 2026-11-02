/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <linux/bpf.h>
#include <poll.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <unistd.h>

_Static_assert(sizeof(struct bpf_insn) == 8, "Linux BPF instruction ABI");
_Static_assert(offsetof(union bpf_attr, insns) == 8, "Linux BPF instruction pointer ABI");
_Static_assert(offsetof(union bpf_attr, license) == 16, "Linux BPF license pointer ABI");
static char verifier_log[16384];
static void fail(const char *what)
{
	printf("::vm-test::fail: bpf syscall: %s errno=%d\n", what, errno);
	fflush(stdout);
	exit(1);
}
#define CHECK(ok, what) do { if (!(ok)) fail(what); } while (0)
static uint64_t pointer(const void *address)
{
	return (uint64_t)(uintptr_t)address;
}
static long command(int cmd, union bpf_attr *attr)
{
	return syscall(SYS_bpf, (long)cmd, attr, (long)sizeof(*attr));
}
static void close_fd(int fd)
{
	CHECK(!close(fd), "close descriptor");
	errno = 0;
	CHECK(fcntl(fd, F_GETFD) == -1 && errno == EBADF, "descriptor released");
}
static long update(int fd, uint32_t value)
{
	uint32_t key = 0;
	union bpf_attr attr = {.map_fd = (uint32_t)fd, .key = pointer(&key),
		.value = pointer(&value), .flags = BPF_ANY};
	return command(BPF_MAP_UPDATE_ELEM, &attr);
}
static uint32_t lookup(int fd)
{
	uint32_t key = 0, value = UINT32_MAX;
	union bpf_attr attr = {.map_fd = (uint32_t)fd, .key = pointer(&key),
		.value = pointer(&value)};
	CHECK(!command(BPF_MAP_LOOKUP_ELEM, &attr), "array lookup");
	return value;
}
static int create_map(void)
{
	union bpf_attr attr = {.map_type = BPF_MAP_TYPE_ARRAY, .key_size = sizeof(uint32_t),
		.value_size = sizeof(uint32_t), .max_entries = 4};
	memcpy(attr.map_name, "wasm_socket", sizeof("wasm_socket"));
	return (int)command(BPF_MAP_CREATE, &attr);
}
static uint32_t map_info(int fd)
{
	struct bpf_map_info info = {0};
	union bpf_attr attr = {0};
	attr.info.bpf_fd = (uint32_t)fd;
	attr.info.info_len = sizeof(info);
	attr.info.info = pointer(&info);
	CHECK(!command(BPF_OBJ_GET_INFO_BY_FD, &attr) && info.id &&
	      info.type == BPF_MAP_TYPE_ARRAY && info.key_size == sizeof(uint32_t) &&
	      info.value_size == sizeof(uint32_t) && info.max_entries == 4 &&
	      !memcmp(info.name, "wasm_socket", sizeof("wasm_socket")), "actual map identity");
	return info.id;
}
static int load_filter(int map, uint32_t map_id)
{
	/* Return array[0] as the socket snapshot length. A missing entry drops the
	 * message. The helper and map reference must run in the actual interpreter. */
	struct bpf_insn program[] = {
		{.code = BPF_LD | BPF_DW | BPF_IMM, .dst_reg = BPF_REG_1,
		 .src_reg = BPF_PSEUDO_MAP_FD, .imm = map},
		{0},
		{.code = BPF_ALU64 | BPF_MOV | BPF_X, .dst_reg = BPF_REG_2, .src_reg = BPF_REG_10},
		{.code = BPF_ALU64 | BPF_ADD | BPF_K, .dst_reg = BPF_REG_2, .imm = -4},
		{.code = BPF_ST | BPF_W | BPF_MEM, .dst_reg = BPF_REG_10, .off = -4, .imm = 0},
		{.code = BPF_JMP | BPF_CALL, .imm = BPF_FUNC_map_lookup_elem},
		{.code = BPF_JMP | BPF_JEQ | BPF_K, .dst_reg = BPF_REG_0, .off = 2, .imm = 0},
		{.code = BPF_LDX | BPF_W | BPF_MEM, .dst_reg = BPF_REG_0, .src_reg = BPF_REG_0},
		{.code = BPF_JMP | BPF_EXIT},
		{.code = BPF_ALU64 | BPF_MOV | BPF_K, .dst_reg = BPF_REG_0, .imm = 0},
		{.code = BPF_JMP | BPF_EXIT},
	};
	union bpf_attr attr = {.prog_type = BPF_PROG_TYPE_SOCKET_FILTER,
		.insn_cnt = sizeof(program) / sizeof(program[0]), .insns = pointer(program),
		.license = pointer("MIT"), .log_level = 1,
		.log_size = sizeof(verifier_log), .log_buf = pointer(verifier_log)};
	memcpy(attr.prog_name, "wasm_filter", sizeof("wasm_filter"));
	int fd = (int)command(BPF_PROG_LOAD, &attr);
	if (fd < 0) {
		int error = errno;
		printf("BPF verifier: %.4096s\n", verifier_log);
		errno = error;
		fail("verify and load socket filter");
	}
	CHECK(fcntl(fd, F_GETFD) & FD_CLOEXEC, "program descriptor is CLOEXEC");
	struct bpf_prog_info info = {.nr_map_ids = 1};
	uint32_t referenced_map = 0;
	info.map_ids = pointer(&referenced_map);
	memset(&attr, 0, sizeof(attr));
	attr.info.bpf_fd = (uint32_t)fd;
	attr.info.info_len = sizeof(info);
	attr.info.info = pointer(&info);
	CHECK(!command(BPF_OBJ_GET_INFO_BY_FD, &attr) && info.id &&
	      info.type == BPF_PROG_TYPE_SOCKET_FILTER && !info.jited_prog_len &&
	      info.nr_map_ids == 1 && referenced_map == map_id, "interpreted program and retained map identity");
	return fd;
}
static void exchange(int sender, int receiver, unsigned char tag)
{
	const unsigned char data[] = {tag, 0, 0xff, 0x42};
	CHECK(send(sender, data, sizeof(data), 0) == sizeof(data), "send binary datagram");
	struct pollfd ready = {.fd = receiver, .events = POLLIN};
	CHECK(poll(&ready, 1, 2000) == 1 && (ready.revents & POLLIN), "accepted message readiness");
	unsigned char received[sizeof(data) + 1];
	CHECK(recv(receiver, received, sizeof(received), MSG_DONTWAIT) == sizeof(data) &&
	      !memcmp(data, received, sizeof(data)), "filter accepts exact datagram");
}
int main(void)
{
	/* Target only: never run this entry on the host. It exercises the system's
	 * BPF interpreter and drops this process's Linux credentials at the end. */
	int map = create_map();
	CHECK(map >= 0 && (fcntl(map, F_GETFD) & FD_CLOEXEC), "create array with CLOEXEC");
	uint32_t id = map_info(map);
	CHECK(!lookup(map) && !update(map, 31) && lookup(map) == 31, "zero initialization and map mutation");
	uint32_t key = 0;
	union bpf_attr attr = {.map_fd = (uint32_t)map, .key = pointer(&key),
		.value = (uint64_t)(uintptr_t)-8};
	errno = 0;
	CHECK(command(BPF_MAP_LOOKUP_ELEM, &attr) == -1 && errno == EFAULT &&
	      lookup(map) == 31, "faulting output preserves map and later lookup");
	int duplicate = fcntl(map, F_DUPFD_CLOEXEC, 0);
	CHECK(duplicate >= 0, "duplicate map descriptor");
	close_fd(map);
	map = duplicate;
	CHECK(map_info(map) == id && lookup(map) == 31, "map descriptor identity after original close");
	puts("bpf syscall: array state, object identity, user-copy fault recovery and descriptor lifetime pass");
	CHECK(!update(map, 0), "set drop policy");
	int program = load_filter(map, id);
	int pair[2];
	CHECK(!socketpair(AF_UNIX, SOCK_DGRAM | SOCK_CLOEXEC, 0, pair), "local datagram pair");
	CHECK(!setsockopt(pair[1], SOL_SOCKET, SO_ATTACH_BPF, &program, sizeof(program)), "attach verified filter");
	close_fd(program);
	const unsigned char dropped[] = {1, 2, 3, 4};
	CHECK(send(pair[0], dropped, sizeof(dropped), 0) == sizeof(dropped), "send dropped message");
	struct pollfd ready = {.fd = pair[1], .events = POLLIN};
	CHECK(!poll(&ready, 1, 150), "map policy really drops message");
	CHECK(!update(map, 65535), "change live filter policy");
	exchange(pair[0], pair[1], 7);
	puts("bpf syscall: verified map-backed socket filter executes helper, drops and accepts binary messages pass");
	memset(&attr, 0, sizeof(attr));
	attr.map_fd = (uint32_t)map;
	CHECK(!command(BPF_MAP_FREEZE, &attr), "freeze array");
	errno = 0;
	CHECK(update(map, 0) == -1 && errno == EPERM && lookup(map) == 65535, "frozen update denied without changing policy");
	close_fd(map);
	CHECK(!setgroups(0, NULL) && !setgid(65534) && !setuid(65534) &&
	      getuid() == 65534 && geteuid() == 65534, "ordinary user credentials");
	errno = 0;
	int denied = create_map();
	CHECK(denied == -1 && errno == EPERM, "upstream unprivileged BPF creation policy");
	exchange(pair[0], pair[1], 9);
	close_fd(pair[0]);
	close_fd(pair[1]);
	puts("bpf syscall: map freeze, unprivileged policy, socket-held program and map cleanup pass");
	return 0;
}
