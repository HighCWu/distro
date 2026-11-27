/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/io_uring.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/syscall.h>
#include <sys/uio.h>
#include <unistd.h>

#ifndef SYS_io_uring_setup
#error "The target Linux UAPI must provide io_uring_setup"
#endif
#ifndef SYS_io_uring_enter
#error "The target Linux UAPI must provide io_uring_enter"
#endif
#ifndef SYS_io_uring_register
#error "The target Linux UAPI must provide io_uring_register"
#endif

enum {
	URING_ENTRIES = 8,
};

static int ring_fd = -1;
static void *ring_ptr = MAP_FAILED;
static size_t ring_size;
static struct io_uring_sqe *sqes = MAP_FAILED;
static size_t sqes_size;
static int file_fd = -1;
static char file_path[] = "/tmp/io-uring-runtime-XXXXXX";
static int file_created;

static void cleanup(void)
{
	if (sqes != MAP_FAILED) {
		(void)munmap(sqes, sqes_size);
		sqes = MAP_FAILED;
	}
	if (ring_ptr != MAP_FAILED) {
		(void)munmap(ring_ptr, ring_size);
		ring_ptr = MAP_FAILED;
	}
	if (ring_fd >= 0) {
		(void)close(ring_fd);
		ring_fd = -1;
	}
	if (file_fd >= 0) {
		(void)close(file_fd);
		file_fd = -1;
	}
	if (file_created) {
		(void)unlink(file_path);
		file_created = 0;
	}
}

static void fail(const char *stage)
{
	int saved_errno = errno;

	fprintf(stderr, "linux io_uring: %s failed (errno=%d)\n", stage,
		saved_errno);
	cleanup();
	errno = saved_errno;
	exit(1);
}

#define CHECK(condition, stage) do { if (!(condition)) fail(stage); } while (0)

static int sys_io_uring_setup(uint32_t entries, struct io_uring_params *p)
{
	return (int)syscall(SYS_io_uring_setup, (long)entries,
			    (long)(uintptr_t)p);
}

static int sys_io_uring_enter(int fd, uint32_t to_submit, uint32_t min_complete,
			      uint32_t flags)
{
	return (int)syscall(SYS_io_uring_enter, (long)fd, (long)to_submit,
			    (long)min_complete, (long)flags, (long)0, (long)0);
}

static int sys_io_uring_register(int fd, unsigned int opcode, const void *arg,
				 unsigned int nr_args)
{
	return (int)syscall(SYS_io_uring_register, (long)fd, (long)opcode,
			    (long)(uintptr_t)arg, (long)nr_args);
}

static void submit_one(const struct io_uring_params *p, uint8_t opcode,
		       uint8_t sqe_flags, int fd, uint64_t addr, uint32_t len,
		       uint64_t offset, uint64_t tag, int32_t expected_res,
		       int enter_fd, uint32_t enter_flags)
{
	uint8_t *base = (uint8_t *)ring_ptr;
	uint32_t *sq_tail = (uint32_t *)(base + p->sq_off.tail);
	uint32_t *sq_mask = (uint32_t *)(base + p->sq_off.ring_mask);
	uint32_t *sq_array = (uint32_t *)(base + p->sq_off.array);
	uint32_t *cq_head = (uint32_t *)(base + p->cq_off.head);
	uint32_t *cq_tail = (uint32_t *)(base + p->cq_off.tail);
	uint32_t *cq_mask = (uint32_t *)(base + p->cq_off.ring_mask);
	struct io_uring_cqe *cqes =
		(struct io_uring_cqe *)(base + p->cq_off.cqes);

	uint32_t tail = *sq_tail;
	uint32_t idx = tail & *sq_mask;
	struct io_uring_sqe *sqe = &sqes[idx];

	memset(sqe, 0, sizeof(*sqe));
	sqe->opcode = opcode;
	sqe->flags = sqe_flags;
	sqe->fd = fd;
	sqe->off = offset;
	sqe->addr = addr;
	sqe->len = len;
	sqe->user_data = tag;

	sq_array[idx] = idx;
	__atomic_store_n(sq_tail, tail + 1, __ATOMIC_RELEASE);

	int ret = sys_io_uring_enter(enter_fd, 1, 1,
				     IORING_ENTER_GETEVENTS | enter_flags);
	CHECK(ret == 1, "io_uring_enter");

	uint32_t c_head = __atomic_load_n(cq_head, __ATOMIC_RELAXED);
	uint32_t c_tail = __atomic_load_n(cq_tail, __ATOMIC_ACQUIRE);
	CHECK(c_head != c_tail, "non-empty cq");

	struct io_uring_cqe *cqe = &cqes[c_head & *cq_mask];
	CHECK(cqe->user_data == tag, "cqe user_data match");
	CHECK(cqe->res == expected_res, "cqe res match");

	__atomic_store_n(cq_head, c_head + 1, __ATOMIC_RELEASE);
}

int main(void)
{
	static const char payload[] = "linux io_uring on wasm\n";
	char readback[sizeof(payload)];
	const uint32_t payload_len = (uint32_t)(sizeof(payload) - 1);
	struct io_uring_params p;

	errno = 0;
	CHECK(sys_io_uring_setup(0, &p) == -1 && errno == EINVAL,
	      "zero entries -> EINVAL");

	errno = 0;
	CHECK(sys_io_uring_setup(URING_ENTRIES, NULL) == -1 && errno == EFAULT,
	      "NULL params -> EFAULT");

	errno = 0;
	CHECK(sys_io_uring_enter(-1, 0, 0, 0) == -1 && errno == EBADF,
	      "bad fd enter -> EBADF");

	memset(&p, 0, sizeof(p));
	ring_fd = sys_io_uring_setup(URING_ENTRIES, &p);
	CHECK(ring_fd >= 0, "io_uring_setup");
	CHECK((p.features & IORING_FEAT_SINGLE_MMAP) != 0,
	      "IORING_FEAT_SINGLE_MMAP");

	size_t sq_sz = p.sq_off.array + p.sq_entries * sizeof(uint32_t);
	size_t cq_sz = p.cq_off.cqes + p.cq_entries * sizeof(struct io_uring_cqe);
	ring_size = sq_sz > cq_sz ? sq_sz : cq_sz;
	ring_ptr = mmap(NULL, ring_size, PROT_READ | PROT_WRITE,
			MAP_SHARED | MAP_POPULATE, ring_fd, IORING_OFF_SQ_RING);
	CHECK(ring_ptr != MAP_FAILED, "mmap SQ/CQ ring");

	sqes_size = p.sq_entries * sizeof(struct io_uring_sqe);
	sqes = mmap(NULL, sqes_size, PROT_READ | PROT_WRITE,
		    MAP_SHARED | MAP_POPULATE, ring_fd, IORING_OFF_SQES);
	CHECK(sqes != MAP_FAILED, "mmap SQEs");

	submit_one(&p, IORING_OP_NOP, 0, -1, 0, 0, 0, UINT64_C(0x11000001), 0,
		   ring_fd, 0);

	file_fd = mkstemp(file_path);
	CHECK(file_fd >= 0, "mkstemp");
	file_created = 1;

	submit_one(&p, IORING_OP_WRITE, 0, file_fd,
		   (uint64_t)(uintptr_t)payload, payload_len, 0,
		   UINT64_C(0x11000002), (int32_t)payload_len, ring_fd, 0);

	memset(readback, 0, sizeof(readback));
	submit_one(&p, IORING_OP_READ, 0, file_fd,
		   (uint64_t)(uintptr_t)readback, payload_len, 0,
		   UINT64_C(0x11000003), (int32_t)payload_len, ring_fd, 0);
	CHECK(memcmp(readback, payload, payload_len) == 0,
	      "verify READ contents after WRITE");

	/* Register file_fd as fixed file 0 and read via IOSQE_FIXED_FILE */
	int reg_fds[1] = { file_fd };
	CHECK(sys_io_uring_register(ring_fd, IORING_REGISTER_FILES, reg_fds, 1) == 0,
	      "IORING_REGISTER_FILES");
	memset(readback, 0, sizeof(readback));
	submit_one(&p, IORING_OP_READ, IOSQE_FIXED_FILE, 0,
		   (uint64_t)(uintptr_t)readback, payload_len, 0,
		   UINT64_C(0x11000004), (int32_t)payload_len, ring_fd, 0);
	CHECK(memcmp(readback, payload, payload_len) == 0,
	      "verify IOSQE_FIXED_FILE READ contents");
	CHECK(sys_io_uring_register(ring_fd, IORING_UNREGISTER_FILES, NULL, 0) == 0,
	      "IORING_UNREGISTER_FILES");

	/* Register ring fd and submit NOP via IORING_ENTER_REGISTERED_RING */
	struct io_uring_rsrc_update ring_upd = {
		.offset = -1U,
		.data = (uint64_t)(unsigned int)ring_fd,
	};
	CHECK(sys_io_uring_register(ring_fd, IORING_REGISTER_RING_FDS,
				    &ring_upd, 1) == 1,
	      "IORING_REGISTER_RING_FDS");
	submit_one(&p, IORING_OP_NOP, 0, -1, 0, 0, 0, UINT64_C(0x11000005), 0,
		   (int)ring_upd.offset, IORING_ENTER_REGISTERED_RING);
	struct io_uring_rsrc_update ring_unreg = {
		.offset = ring_upd.offset,
	};
	CHECK(sys_io_uring_register(ring_fd, IORING_UNREGISTER_RING_FDS,
				    &ring_unreg, 1) == 1,
	      "IORING_UNREGISTER_RING_FDS");

	/* Verify IORING_REGISTER_BUFFERS rejects unpinnable / bad user buffers */
	struct iovec bad_iov = {
		.iov_base = (void *)(uintptr_t)0x1000,
		.iov_len = 4096,
	};
	errno = 0;
	CHECK(sys_io_uring_register(ring_fd, IORING_REGISTER_BUFFERS, &bad_iov,
				    1) == -1 && errno == EFAULT,
	      "bad IORING_REGISTER_BUFFERS -> EFAULT");
#ifdef __wasm__
	struct iovec wasm_iov = {
		.iov_base = readback,
		.iov_len = sizeof(readback),
	};
	errno = 0;
	CHECK(sys_io_uring_register(ring_fd, IORING_REGISTER_BUFFERS, &wasm_iov,
				    1) == -1 &&
	      (errno == EFAULT || errno == EOPNOTSUPP),
	      "wasm IORING_REGISTER_BUFFERS -> EFAULT/EOPNOTSUPP");
#endif

	cleanup();
	puts("LINUX_IO_URING_OK nop=0 write=23 read=23 fixed_file=1 reg_ring=1");
	return 0;
}
