// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/inotify.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <unistd.h>

#define BASE_DIR "/tmp/inotify-test"
#define WATCH_DIR BASE_DIR "/watchdir"
#define ONESHOT_FILE BASE_DIR "/oneshot.txt"

static void require(int ok, const char *what)
{
	if (ok) return;
	fprintf(stderr, "inotify-runtime: %s (errno=%d: %s)\n", what, errno,
		strerror(errno));
	exit(1);
}

struct dir_events_state {
	int saw_create;
	int saw_modify;
	int saw_attrib;
	int saw_moved_from;
	int saw_moved_to;
	int saw_delete;
	int saw_delete_self;
	int saw_ignored;
	uint32_t moved_from_cookie;
	uint32_t moved_to_cookie;
};

static void drain_dir_events(int ifd, int wd, struct dir_events_state *st,
			     uint32_t stop_mask)
{
	char buf[4096] __attribute__((aligned(__alignof__(struct inotify_event))));
	for (int round = 0; round < 16; round++) {
		struct pollfd pfd = { .fd = ifd, .events = POLLIN };
		int prc = poll(&pfd, 1, 2000);
		require(prc > 0 && (pfd.revents & POLLIN), "poll inotify fd");

		for (;;) {
			ssize_t n = read(ifd, buf, sizeof(buf));
			if (n < 0) {
				if (errno == EINTR) continue;
				if (errno == EAGAIN) break;
				require(0, "read inotify events");
			}
			require(n > 0, "non-empty inotify read");

			const char *ptr = buf;
			while (ptr < buf + n) {
				const struct inotify_event *ev =
					(const struct inotify_event *)ptr;
				require(ev->wd == wd, "event matches expected wd");
				if ((ev->mask & IN_CREATE) && ev->len > 0 &&
				    strcmp(ev->name, "a.txt") == 0) {
					st->saw_create = 1;
				}
				if ((ev->mask & IN_MODIFY) && ev->len > 0 &&
				    strcmp(ev->name, "a.txt") == 0) {
					st->saw_modify = 1;
				}
				if ((ev->mask & IN_ATTRIB) && ev->len > 0 &&
				    strcmp(ev->name, "a.txt") == 0) {
					st->saw_attrib = 1;
				}
				if ((ev->mask & IN_MOVED_FROM) && ev->len > 0 &&
				    strcmp(ev->name, "a.txt") == 0) {
					st->saw_moved_from = 1;
					st->moved_from_cookie = ev->cookie;
				}
				if ((ev->mask & IN_MOVED_TO) && ev->len > 0 &&
				    strcmp(ev->name, "b.txt") == 0) {
					st->saw_moved_to = 1;
					st->moved_to_cookie = ev->cookie;
				}
				if ((ev->mask & IN_DELETE) && ev->len > 0 &&
				    strcmp(ev->name, "b.txt") == 0) {
					st->saw_delete = 1;
				}
				if (ev->mask & IN_DELETE_SELF) {
					st->saw_delete_self = 1;
				}
				if (ev->mask & IN_IGNORED) {
					st->saw_ignored = 1;
				}
				ptr += sizeof(*ev) + ev->len;
			}
		}

		if (stop_mask == IN_DELETE) {
			if (st->saw_create && st->saw_modify && st->saw_attrib &&
			    st->saw_moved_from && st->saw_moved_to &&
			    st->saw_delete) {
				return;
			}
		} else if (stop_mask == IN_IGNORED) {
			if (st->saw_delete_self && st->saw_ignored) {
				return;
			}
		}
	}
	require(0, "timed out waiting for expected inotify events");
}

static void drain_expect_mask(int ifd, int wd, uint32_t want_mask)
{
	char buf[4096] __attribute__((aligned(__alignof__(struct inotify_event))));
	uint32_t seen = 0;

	for (int round = 0; round < 10 && (seen & want_mask) != want_mask;
	     round++) {
		struct pollfd pfd = { .fd = ifd, .events = POLLIN };
		int prc = poll(&pfd, 1, 2000);
		require(prc > 0 && (pfd.revents & POLLIN),
			"poll inotify fd for mask");

		for (;;) {
			ssize_t n = read(ifd, buf, sizeof(buf));
			if (n < 0) {
				if (errno == EINTR) continue;
				if (errno == EAGAIN) break;
				require(0, "read inotify mask events");
			}
			const char *ptr = buf;
			while (ptr < buf + n) {
				const struct inotify_event *ev =
					(const struct inotify_event *)ptr;
				require(ev->wd == wd, "wd matches");
				seen |= ev->mask;
				ptr += sizeof(*ev) + ev->len;
			}
		}
	}
	require((seen & want_mask) == want_mask, "observed expected watch mask");
}

int main(void)
{
	setvbuf(stdout, NULL, _IONBF, 0);

	require(mkdir(BASE_DIR, 0755) == 0, "mkdir base tmpfs mountpoint");
	require(mount("tmpfs", BASE_DIR, "tmpfs", 0, NULL) == 0,
		"mount tmpfs for inotify test");

	int ifd = inotify_init1(IN_NONBLOCK | IN_CLOEXEC);
	require(ifd >= 0, "inotify_init1(IN_NONBLOCK | IN_CLOEXEC)");

	int fd_flags = fcntl(ifd, F_GETFD);
	require(fd_flags >= 0 && (fd_flags & FD_CLOEXEC) != 0,
		"inotify fd has FD_CLOEXEC");
	int fl_flags = fcntl(ifd, F_GETFL);
	require(fl_flags >= 0 && (fl_flags & O_NONBLOCK) != 0,
		"inotify fd has O_NONBLOCK");

	char empty_buf[64];
	errno = 0;
	require(read(ifd, empty_buf, sizeof(empty_buf)) == -1 &&
			errno == EAGAIN,
		"empty nonblock inotify read returns EAGAIN");

	/* Directory watch + IN_MASK_ADD + lifecycle events + move cookie. */
	require(mkdir(WATCH_DIR, 0755) == 0, "mkdir watchdir");
	int wd = inotify_add_watch(ifd, WATCH_DIR,
				   IN_CREATE | IN_MODIFY | IN_DELETE);
	require(wd >= 0, "inotify_add_watch initial");
	int wd2 = inotify_add_watch(
		ifd, WATCH_DIR,
		IN_MASK_ADD | IN_ATTRIB | IN_MOVE | IN_DELETE_SELF);
	require(wd2 == wd, "IN_MASK_ADD updates existing wd");

	int f = open(WATCH_DIR "/a.txt", O_CREAT | O_WRONLY | O_TRUNC, 0644);
	require(f >= 0, "create a.txt");
	require(write(f, "hello", 5) == 5, "write a.txt");
	require(close(f) == 0, "close a.txt");
	require(chmod(WATCH_DIR "/a.txt", 0600) == 0, "chmod a.txt");
	require(rename(WATCH_DIR "/a.txt", WATCH_DIR "/b.txt") == 0,
		"rename a.txt -> b.txt");
	require(unlink(WATCH_DIR "/b.txt") == 0, "unlink b.txt");

	struct dir_events_state st;
	memset(&st, 0, sizeof(st));
	drain_dir_events(ifd, wd, &st, IN_DELETE);
	require(st.moved_from_cookie != 0 &&
			st.moved_from_cookie == st.moved_to_cookie,
		"IN_MOVED_FROM and IN_MOVED_TO share non-zero cookie");

	require(rmdir(WATCH_DIR) == 0, "rmdir watchdir");
	drain_dir_events(ifd, wd, &st, IN_IGNORED);

	/* IN_ONESHOT and explicit inotify_rm_watch. */
	int ofd = open(ONESHOT_FILE, O_CREAT | O_WRONLY | O_TRUNC, 0644);
	require(ofd >= 0, "create oneshot.txt");
	require(close(ofd) == 0, "close oneshot.txt");

	int owd = inotify_add_watch(ifd, ONESHOT_FILE, IN_ATTRIB | IN_ONESHOT);
	require(owd >= 0, "inotify_add_watch IN_ONESHOT");
	require(chmod(ONESHOT_FILE, 0600) == 0, "chmod triggers IN_ONESHOT");
	drain_expect_mask(ifd, owd, IN_ATTRIB | IN_IGNORED);

	require(chmod(ONESHOT_FILE, 0644) == 0,
		"second chmod after IN_ONESHOT");
	errno = 0;
	require(read(ifd, empty_buf, sizeof(empty_buf)) == -1 &&
			errno == EAGAIN,
		"no events queued after IN_ONESHOT auto-removal");
	errno = 0;
	require(inotify_rm_watch(ifd, owd) == -1 && errno == EINVAL,
		"inotify_rm_watch on auto-removed wd returns EINVAL");

	int rwd = inotify_add_watch(ifd, ONESHOT_FILE, IN_MODIFY);
	require(rwd >= 0, "add watch for explicit inotify_rm_watch");
	require(inotify_rm_watch(ifd, rwd) == 0, "explicit inotify_rm_watch");
	drain_expect_mask(ifd, rwd, IN_IGNORED);

	require(unlink(ONESHOT_FILE) == 0, "unlink oneshot.txt");
	require(close(ifd) == 0, "close inotify fd");
	require(umount(BASE_DIR) == 0, "umount backing tmpfs");
	require(rmdir(BASE_DIR) == 0, "rmdir base dir");

	puts("inotify runtime: nonblock/cloexec, events, move cookie, IN_MASK_ADD, IN_ONESHOT and rm_watch pass");
	return 0;
}
