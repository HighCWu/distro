// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/fanotify.h>
#include <unistd.h>

static void require(int ok, const char *what)
{
	if (ok) return;
	fprintf(stderr, "fanotify-runtime: %s (errno=%d: %s)\n", what, errno,
		strerror(errno));
	exit(1);
}

static void write_all(int fd, const void *buf, size_t len)
{
	const char *p = (const char *)buf;
	size_t done = 0;
	while (done < len) {
		ssize_t n = write(fd, p + done, len - done);
		if (n < 0 && errno == EINTR) continue;
		require(n > 0, "write complete buffer");
		done += (size_t)n;
	}
}

struct perm_worker_args {
	const char *path;
	const char *expected;
};

static void *perm_worker_main(void *arg)
{
	struct perm_worker_args *args = (struct perm_worker_args *)arg;

	int allowed_fd = open(args->path, O_RDONLY);
	require(allowed_fd >= 0, "worker open allowed by FAN_ALLOW");
	char buf[64] = { 0 };
	ssize_t n = read(allowed_fd, buf, sizeof(buf) - 1);
	require(n == (ssize_t)strlen(args->expected), "read allowed file length");
	require(strcmp(buf, args->expected) == 0, "read allowed file contents");
	require(close(allowed_fd) == 0, "close allowed file");

	errno = 0;
	int denied_fd = open(args->path, O_RDONLY);
	require(denied_fd == -1 && errno == EPERM,
		"worker open denied by FAN_DENY reports EPERM");
	return NULL;
}

static void test_notifications(const char *dir)
{
	char path[PATH_MAX];
	int len = snprintf(path, sizeof(path), "%s/notif.txt", dir);
	require(len > 0 && (size_t)len < sizeof(path), "format notif path");

	int init_fd = open(path, O_CREAT | O_WRONLY | O_TRUNC, 0600);
	require(init_fd >= 0, "create notif target file");
	require(close(init_fd) == 0, "close initial notif file");

	int fan_fd = fanotify_init(FAN_CLOEXEC | FAN_CLASS_NOTIF | FAN_NONBLOCK,
				   O_RDONLY | O_LARGEFILE);
	require(fan_fd >= 0, "fanotify_init(FAN_CLASS_NOTIF)");

	require(fanotify_mark(fan_fd, FAN_MARK_ADD,
			      FAN_OPEN | FAN_MODIFY | FAN_CLOSE_WRITE, AT_FDCWD,
			      path) == 0,
		"fanotify_mark(FAN_MARK_ADD)");

	const char *payload = "fanotify-notif-payload";
	int target_fd = open(path, O_WRONLY | O_TRUNC);
	require(target_fd >= 0, "open notif target for write");
	write_all(target_fd, payload, strlen(payload));
	require(close(target_fd) == 0, "close notif target");

	uint64_t seen_mask = 0;
	int saw_payload_via_event_fd = 0;
	const uint64_t want_mask = FAN_OPEN | FAN_MODIFY | FAN_CLOSE_WRITE;

	for (int round = 0; round < 10 && (seen_mask & want_mask) != want_mask; round++) {
		struct pollfd pfd = { .fd = fan_fd, .events = POLLIN };
		int prc = poll(&pfd, 1, 2000);
		require(prc > 0 && (pfd.revents & POLLIN), "poll fan_fd");

		char buf[4096];
		ssize_t n = read(fan_fd, buf, sizeof(buf));
		if (n < 0 && (errno == EAGAIN || errno == EINTR)) continue;
		require(n > 0, "read fanotify notification metadata");

		const struct fanotify_event_metadata *meta =
			(const struct fanotify_event_metadata *)buf;
		while (FAN_EVENT_OK(meta, n)) {
			require(meta->vers == FANOTIFY_METADATA_VERSION,
				"fanotify metadata version");
			require(meta->pid == getpid(), "fanotify metadata pid");
			require(meta->fd >= 0, "fanotify notification event fd");
			seen_mask |= meta->mask;
			if (meta->mask & FAN_CLOSE_WRITE) {
				char verify[64] = { 0 };
				require(lseek(meta->fd, 0, SEEK_SET) == 0,
					"lseek event fd");
				ssize_t rn = read(meta->fd, verify, sizeof(verify) - 1);
				if (rn == (ssize_t)strlen(payload) &&
				    strcmp(verify, payload) == 0) {
					saw_payload_via_event_fd = 1;
				}
			}
			require(close(meta->fd) == 0, "close notification event fd");
			meta = FAN_EVENT_NEXT(meta, n);
		}
	}

	require((seen_mask & want_mask) == want_mask,
		"observed FAN_OPEN | FAN_MODIFY | FAN_CLOSE_WRITE");
	require(saw_payload_via_event_fd, "verified payload via fanotify event fd");
	require(close(fan_fd) == 0, "close notification fan_fd");
}

static void handle_one_perm_event(int perm_fd, uint32_t verdict)
{
	struct pollfd pfd = { .fd = perm_fd, .events = POLLIN };
	int prc = poll(&pfd, 1, 5000);
	require(prc > 0 && (pfd.revents & POLLIN), "poll perm_fd");

	char buf[4096];
	ssize_t n = read(perm_fd, buf, sizeof(buf));
	require(n > 0, "read fanotify permission metadata");

	const struct fanotify_event_metadata *meta =
		(const struct fanotify_event_metadata *)buf;
	require(FAN_EVENT_OK(meta, n), "valid permission event");
	require(meta->vers == FANOTIFY_METADATA_VERSION, "perm metadata version");
	require((meta->mask & FAN_OPEN_PERM) != 0, "event carries FAN_OPEN_PERM");
	require(meta->fd >= 0, "perm event carries valid fd");

	struct fanotify_response response = {
		.fd = meta->fd,
		.response = verdict,
	};
	write_all(perm_fd, &response, sizeof(response));
	require(close(meta->fd) == 0, "close perm event fd");
}

static void test_permissions(const char *dir)
{
	char path[PATH_MAX];
	int len = snprintf(path, sizeof(path), "%s/perm.txt", dir);
	require(len > 0 && (size_t)len < sizeof(path), "format perm path");

	const char *expected = "fanotify-perm-ok";
	int init_fd = open(path, O_CREAT | O_WRONLY | O_TRUNC, 0600);
	require(init_fd >= 0, "create perm target file");
	write_all(init_fd, expected, strlen(expected));
	require(close(init_fd) == 0, "close perm target file");

	int perm_fd = fanotify_init(FAN_CLOEXEC | FAN_CLASS_CONTENT,
				    O_RDONLY | O_LARGEFILE);
	require(perm_fd >= 0, "fanotify_init(FAN_CLASS_CONTENT)");

	require(fanotify_mark(perm_fd, FAN_MARK_ADD, FAN_OPEN_PERM, AT_FDCWD,
			      path) == 0,
		"fanotify_mark(FAN_OPEN_PERM)");

	struct perm_worker_args args = { .path = path, .expected = expected };
	pthread_t worker;
	require(pthread_create(&worker, NULL, perm_worker_main, &args) == 0,
		"pthread_create perm worker");

	handle_one_perm_event(perm_fd, FAN_ALLOW);
	handle_one_perm_event(perm_fd, FAN_DENY);

	void *worker_result = (void *)1;
	require(pthread_join(worker, &worker_result) == 0 && worker_result == NULL,
		"pthread_join perm worker");

	require(fanotify_mark(perm_fd, FAN_MARK_REMOVE, FAN_OPEN_PERM, AT_FDCWD,
			      path) == 0,
		"fanotify_mark(FAN_MARK_REMOVE)");
	require(close(perm_fd) == 0, "close perm_fd");
}

int main(void)
{
	setvbuf(stdout, NULL, _IONBF, 0);

	char dir[] = "/tmp/fanotify-XXXXXX";
	require(mkdtemp(dir) != NULL, "mkdtemp");

	test_notifications(dir);
	test_permissions(dir);

	char notif_path[PATH_MAX];
	char perm_path[PATH_MAX];
	snprintf(notif_path, sizeof(notif_path), "%s/notif.txt", dir);
	snprintf(perm_path, sizeof(perm_path), "%s/perm.txt", dir);
	require(unlink(notif_path) == 0, "unlink notif.txt");
	require(unlink(perm_path) == 0, "unlink perm.txt");
	require(rmdir(dir) == 0, "rmdir temp dir");

	puts("fanotify runtime: FAN_CLASS_NOTIF and FAN_OPEN_PERM allow/deny pass");
	return 0;
}
