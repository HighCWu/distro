/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/aio_abi.h>
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/eventfd.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef SYS_io_setup
#error "The target Linux UAPI must provide io_setup"
#endif
#ifndef SYS_io_destroy
#error "The target Linux UAPI must provide io_destroy"
#endif
#ifndef SYS_io_submit
#error "The target Linux UAPI must provide io_submit"
#endif
#ifndef SYS_io_getevents
#error "The target Linux UAPI must provide io_getevents"
#endif

enum {
	EVENTFD_TIMEOUT_MS = 5000,
	AIO_EVENT_COUNT = 8,
};

static aio_context_t context;
static int context_ready;
static int file_fd = -1;
static int completion_fd = -1;
static char file_path[] = "/tmp/aio-runtime-XXXXXX";
static int file_created;

static void cleanup(void)
{
	if (context_ready) {
		(void)syscall(SYS_io_destroy, (long)context);
		context_ready = 0;
		context = 0;
	}
	if (completion_fd >= 0) {
		(void)close(completion_fd);
		completion_fd = -1;
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

	fprintf(stderr, "linux AIO: %s failed (errno=%d)\n", stage, saved_errno);
	cleanup();
	errno = saved_errno;
	exit(1);
}

#define CHECK(condition, stage) do { if (!(condition)) fail(stage); } while (0)

static void wait_for_completion(void)
{
	struct pollfd pfd = {
		.fd = completion_fd,
		.events = POLLIN,
	};
	int ret;

	do {
		ret = poll(&pfd, 1, EVENTFD_TIMEOUT_MS);
	} while (ret < 0 && errno == EINTR);
	CHECK(ret > 0, "wait for eventfd completion");
	CHECK((pfd.revents & POLLIN) != 0, "eventfd readable");

	uint64_t value = 0;
	ssize_t bytes;
	do {
		bytes = read(completion_fd, &value, sizeof(value));
	} while (bytes < 0 && errno == EINTR);
	CHECK(bytes == (ssize_t)sizeof(value), "read eventfd counter");
	CHECK(value == 1, "one eventfd signal per AIO request");
}

static void submit_and_check(struct iocb *request, uint64_t tag,
			     int64_t expected_result)
{
	struct iocb *requests[] = { request };
	struct io_event event = { 0 };
	long ret;

	do {
		ret = syscall(SYS_io_submit, (long)context, (long)1,
			      (long)(uintptr_t)requests);
	} while (ret < 0 && errno == EINTR);
	CHECK(ret == 1, "submit one AIO request");

	wait_for_completion();
	do {
		ret = syscall(SYS_io_getevents, (long)context, (long)1, (long)1,
			      (long)(uintptr_t)&event, (long)0);
	} while (ret < 0 && errno == EINTR);
	CHECK(ret == 1, "collect one AIO event");
	CHECK(event.data == tag, "AIO event data tag");
	CHECK(event.res == expected_result, "AIO byte count");
	CHECK(event.res2 == 0, "AIO secondary result");
}

static void prepare_request(struct iocb *request, uint16_t opcode,
			    void *buffer, size_t length, uint64_t tag)
{
	memset(request, 0, sizeof(*request));
	request->aio_data = tag;
	request->aio_lio_opcode = opcode;
	request->aio_fildes = (uint32_t)file_fd;
	request->aio_buf = (uint64_t)(uintptr_t)buffer;
	request->aio_nbytes = (uint64_t)length;
	request->aio_offset = 0;
	request->aio_flags = IOCB_FLAG_RESFD;
	request->aio_resfd = (uint32_t)completion_fd;
}

int main(void)
{
	static const char expected[] = "linux aio on wasm\n";
	char readback[sizeof(expected)];
	const size_t payload_length = sizeof(expected) - 1;
	struct iocb request;
	long ret;

	file_fd = mkstemp(file_path);
	CHECK(file_fd >= 0, "create regular file");
	file_created = 1;
	completion_fd = eventfd(0, EFD_CLOEXEC | EFD_NONBLOCK);
	CHECK(completion_fd >= 0, "create completion eventfd");

	ret = syscall(SYS_io_setup, (long)AIO_EVENT_COUNT,
		      (long)(uintptr_t)&context);
	CHECK(ret == 0, "io_setup");
	context_ready = 1;

	prepare_request(&request, IOCB_CMD_PWRITE, (void *)expected,
			payload_length, UINT64_C(0xa10a1001));
	submit_and_check(&request, UINT64_C(0xa10a1001), payload_length);

	memset(readback, 0, sizeof(readback));
	prepare_request(&request, IOCB_CMD_PREAD, readback, payload_length,
			UINT64_C(0xa10a1002));
	submit_and_check(&request, UINT64_C(0xa10a1002), payload_length);
	CHECK(memcmp(readback, expected, payload_length) == 0,
	      "verify PREAD contents after PWRITE");

	ret = syscall(SYS_io_destroy, (long)context);
	CHECK(ret == 0, "io_destroy");
	context_ready = 0;
	context = 0;
	cleanup();
	puts("LINUX_AIO_OK write=18 read=18 eventfd=2");
	return 0;
}
