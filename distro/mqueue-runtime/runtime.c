/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <mqueue.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static const char mq_name[] = "/wasm_mqueue_test";
static mqd_t mq = (mqd_t)-1;
static int mq_created;
static volatile sig_atomic_t notify_count;

static void on_sigusr1(int signo)
{
	(void)signo;
	notify_count++;
}

static void cleanup(void)
{
	if (mq != (mqd_t)-1) {
		(void)mq_close(mq);
		mq = (mqd_t)-1;
	}
	if (mq_created) {
		(void)mq_unlink(mq_name);
		mq_created = 0;
	}
}

static void fail(const char *stage)
{
	int saved_errno = errno;

	fprintf(stderr, "linux mqueue: %s failed (errno=%d)\n", stage,
		saved_errno);
	cleanup();
	errno = saved_errno;
	exit(1);
}

#define CHECK(condition, stage) do { if (!(condition)) fail(stage); } while (0)

int main(void)
{
	struct sigaction sa;
	memset(&sa, 0, sizeof(sa));
	sa.sa_handler = on_sigusr1;
	sigemptyset(&sa.sa_mask);
	CHECK(sigaction(SIGUSR1, &sa, NULL) == 0, "sigaction SIGUSR1");

	(void)mq_unlink(mq_name);

	struct mq_attr attr = {
		.mq_flags = 0,
		.mq_maxmsg = 4,
		.mq_msgsize = 64,
		.mq_curmsgs = 0,
	};
	mq = mq_open(mq_name, O_CREAT | O_EXCL | O_RDWR | O_NONBLOCK, 0600,
		     &attr);
	CHECK(mq != (mqd_t)-1, "mq_open");
	mq_created = 1;

	struct mq_attr got = { 0 };
	CHECK(mq_getattr(mq, &got) == 0, "mq_getattr");
	CHECK(got.mq_maxmsg == 4 && got.mq_msgsize == 64,
	      "mq_getattr dimensions");

	struct sigevent sev;
	memset(&sev, 0, sizeof(sev));
	sev.sigev_notify = SIGEV_SIGNAL;
	sev.sigev_signo = SIGUSR1;
	CHECK(mq_notify(mq, &sev) == 0, "mq_notify SIGEV_SIGNAL");

	static const char msg_low[] = "prio-low";
	static const char msg_high[] = "prio-high";
	struct timespec ts = { 0, 0 };

	CHECK(mq_timedsend(mq, msg_low, sizeof(msg_low), 10, &ts) == 0,
	      "mq_timedsend prio 10");
	CHECK(notify_count == 1, "mq_notify delivered SIGUSR1");
	CHECK(mq_timedsend(mq, msg_high, sizeof(msg_high), 20, &ts) == 0,
	      "mq_timedsend prio 20");

	char buf[64];
	unsigned int prio = 0;
	ssize_t n = mq_timedreceive(mq, buf, sizeof(buf), &prio, &ts);
	CHECK(n == (ssize_t)sizeof(msg_high), "mq_timedreceive high len");
	CHECK(prio == 20 && memcmp(buf, msg_high, sizeof(msg_high)) == 0,
	      "mq_timedreceive high prio & payload");

	n = mq_timedreceive(mq, buf, sizeof(buf), &prio, &ts);
	CHECK(n == (ssize_t)sizeof(msg_low), "mq_timedreceive low len");
	CHECK(prio == 10 && memcmp(buf, msg_low, sizeof(msg_low)) == 0,
	      "mq_timedreceive low prio & payload");

	errno = 0;
	CHECK(mq_timedreceive(mq, buf, sizeof(buf), &prio, &ts) == -1 &&
	      errno == EAGAIN,
	      "empty nonblock mq_timedreceive -> EAGAIN");

	errno = 0;
	CHECK(mq_getattr((mqd_t)-1, &got) == -1 && errno == EBADF,
	      "bad mqd_t -> EBADF");

	CHECK(mq_close(mq) == 0, "mq_close");
	mq = (mqd_t)-1;
	CHECK(mq_unlink(mq_name) == 0, "mq_unlink");
	mq_created = 0;

	puts("LINUX_MQUEUE_OK prio=20,10 notify=1");
	return 0;
}
