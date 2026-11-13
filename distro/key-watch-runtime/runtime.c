/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <errno.h>
#include <linux/keyctl.h>
#include <linux/watch_queue.h>
#include <poll.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef KEYCTL_WATCH_KEY
#define KEYCTL_WATCH_KEY 32
#endif

enum {
	WATCH_ID = 0x2a,
	WATCH_QUEUE_NOTES = 128,
	WAIT_TIMEOUT_MS = 5000,
};

_Static_assert(sizeof(struct watch_notification) == 8, "watch header UAPI size");
_Static_assert(sizeof(struct key_notification) == 16, "key notification UAPI size");
_Static_assert(sizeof(struct watch_notification_type_filter) == 44,
	       "watch filter entry UAPI size");
_Static_assert(offsetof(struct watch_notification_filter, filters) == 8,
	       "watch filter header UAPI size");

static int notification_pipe[2] = { -1, -1 };
static int32_t session_keyring;
static int32_t watched_key;
static int watch_installed;

static long keyctl_call(long command, unsigned long arg2, unsigned long arg3,
		unsigned long arg4, unsigned long arg5)
{
	return syscall(SYS_keyctl, command, arg2, arg3, arg4, arg5);
}

static int cleanup(void)
{
	int saved_errno = errno;
	int cleanup_errno = 0;

	if (watch_installed && watched_key > 0 && notification_pipe[1] >= 0) {
		if (keyctl_call(KEYCTL_WATCH_KEY, (unsigned long)(uint32_t)watched_key,
				(unsigned long)notification_pipe[1], UINT32_MAX, 0) < 0)
			cleanup_errno = errno;
		watch_installed = 0;
	}
	for (size_t i = 0; i < sizeof(notification_pipe) / sizeof(notification_pipe[0]); i++) {
		if (notification_pipe[i] >= 0) {
			if (close(notification_pipe[i]) < 0 && !cleanup_errno)
				cleanup_errno = errno;
			notification_pipe[i] = -1;
		}
	}
	if (watched_key > 0) {
		if (keyctl_call(KEYCTL_REVOKE, (unsigned long)(uint32_t)watched_key,
				0, 0, 0) < 0 && !cleanup_errno)
			cleanup_errno = errno;
		watched_key = 0;
	}
	if (session_keyring > 0) {
		if (keyctl_call(KEYCTL_CLEAR, (unsigned long)(uint32_t)session_keyring,
				0, 0, 0) < 0 && !cleanup_errno)
			cleanup_errno = errno;
		session_keyring = 0;
	}
	errno = cleanup_errno ? cleanup_errno : saved_errno;
	return cleanup_errno ? -1 : 0;
}

static void fail(const char *stage)
{
	int saved_errno = errno;
	(void)cleanup();
	errno = saved_errno;
	fprintf(stderr, "key watch runtime: %s failed (errno=%d)\n", stage, errno);
	fputs("::vm-test::fail: key watch notification consumer failed\n", stderr);
	fflush(NULL);
	_exit(1);
}

#define CHECK(condition, stage) do { if (!(condition)) fail(stage); } while (0)

static void make_filter(void)
{
	struct watch_notification_filter header = {
		.nr_filters = 1,
		.__reserved = 0,
	};
	struct watch_notification_type_filter type_filter = {
		.type = WATCH_TYPE_KEY_NOTIFY,
		.info_filter = 0,
		.info_mask = 0,
		.subtype_filter = { 0 },
	};
	unsigned char filter_bytes[sizeof(header) + sizeof(type_filter)];

	type_filter.subtype_filter[NOTIFY_KEY_UPDATED / 32] =
		1U << (NOTIFY_KEY_UPDATED % 32);
	memcpy(filter_bytes, &header, sizeof(header));
	memcpy(filter_bytes + sizeof(header), &type_filter, sizeof(type_filter));
	CHECK(sizeof(filter_bytes) == 52, "watch filter layout");
	CHECK(ioctl(notification_pipe[1], IOC_WATCH_QUEUE_SET_FILTER,
		    filter_bytes) == 0, "install key update filter");
}

static void read_and_check_update(void)
{
	unsigned char buffer[128];
	struct pollfd pfd = {
		.fd = notification_pipe[0],
		.events = POLLIN,
	};
	int ready;
	do {
		ready = poll(&pfd, 1, WAIT_TIMEOUT_MS);
	} while (ready < 0 && errno == EINTR);
	CHECK(ready > 0, "wait for key update notification");
	CHECK((pfd.revents & POLLIN) != 0, "notification pipe readable");

	ssize_t bytes;
	do {
		bytes = read(notification_pipe[0], buffer, sizeof(buffer));
	} while (bytes < 0 && errno == EINTR);
	CHECK(bytes >= (ssize_t)sizeof(struct key_notification),
	      "read key update notification");

	int matched = 0;
	for (size_t offset = 0; offset < (size_t)bytes;) {
		CHECK((size_t)bytes - offset >= sizeof(struct watch_notification),
		      "complete watch notification header");
		struct watch_notification watch;
		memcpy(&watch, buffer + offset, sizeof(watch));
		size_t length = (watch.info & WATCH_INFO_LENGTH) >>
			WATCH_INFO_LENGTH__SHIFT;
		CHECK(length >= sizeof(watch) && length <= (size_t)bytes - offset,
		      "watch notification record length");
		if (watch.type == WATCH_TYPE_KEY_NOTIFY &&
		    watch.subtype == NOTIFY_KEY_UPDATED) {
			CHECK(length == sizeof(struct key_notification),
			      "key update record size");
			struct key_notification key_note;
			memcpy(&key_note, buffer + offset, sizeof(key_note));
			CHECK(((watch.info & WATCH_INFO_ID) >> WATCH_INFO_ID__SHIFT) == WATCH_ID,
			      "watch id in key notification");
			CHECK(key_note.key_id == (uint32_t)watched_key,
			      "key serial in notification");
			CHECK(key_note.aux == 0, "key update auxiliary field");
			matched++;
		}
		offset += length;
	}
	CHECK(matched == 1, "exactly one filtered key update");
}

int main(void)
{
	static const unsigned char initial_payload[] = "watch-before";
	static const unsigned char updated_payload[] = "watch-after";

	long ring = keyctl_call(KEYCTL_JOIN_SESSION_KEYRING, 0, 0, 0, 0);
	CHECK(ring > 0 && ring <= INT32_MAX, "create private session keyring");
	session_keyring = (int32_t)ring;

	long key = syscall(SYS_add_key, (unsigned long)(uintptr_t)"user",
			   (unsigned long)(uintptr_t)"watch-queue-key",
			   (unsigned long)(uintptr_t)initial_payload,
			   (unsigned long)sizeof(initial_payload),
			   (unsigned long)(uint32_t)session_keyring);
	CHECK(key > 0 && key <= INT32_MAX, "add user key to private session keyring");
	watched_key = (int32_t)key;

	CHECK(pipe2(notification_pipe,
		   O_NOTIFICATION_PIPE | O_NONBLOCK | O_CLOEXEC) == 0,
	      "create notification pipe");
	CHECK(ioctl(notification_pipe[1], IOC_WATCH_QUEUE_SET_SIZE,
		    (unsigned long)WATCH_QUEUE_NOTES) == 0,
	      "size notification queue");
	make_filter();
	CHECK(keyctl_call(KEYCTL_WATCH_KEY, (unsigned long)(uint32_t)watched_key,
			  (unsigned long)notification_pipe[1], WATCH_ID, 0) == 0,
	      "watch user key");
	watch_installed = 1;
	CHECK(keyctl_call(KEYCTL_UPDATE, (unsigned long)(uint32_t)watched_key,
			  (unsigned long)(uintptr_t)updated_payload,
			  (unsigned long)sizeof(updated_payload), 0) == 0,
	      "update watched user key");
	read_and_check_update();
	CHECK(cleanup() == 0, "remove watch and clean private keyring");
	puts("KEY_WATCH_NOTIFICATION_OK type=1 subtype=1 id=42 length=16");
	return 0;
}
