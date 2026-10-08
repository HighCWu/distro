/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include "test.h"

#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <sys/select.h>
#include <sys/timerfd.h>
#include <time.h>
#include <unistd.h>

#define LONG_SECONDS 3000000000LL

static void valid_timespec(const struct timespec *ts)
{
	if (ts->tv_sec < 0 || ts->tv_nsec < 0 || ts->tv_nsec >= 1000000000)
		test_fail("invalid clock or timer timespec");
}

static void long_timer(const struct itimerspec *value)
{
	valid_timespec(&value->it_value);
	if (value->it_interval.tv_sec != LONG_SECONDS ||
	    value->it_interval.tv_nsec != 123456789 ||
	    value->it_value.tv_sec <= 2147483647LL ||
	    value->it_value.tv_sec > LONG_SECONDS)
		test_fail("long timer interval or remaining time was truncated");
}

static void unchanged_timeout(const struct timespec *value)
{
	if (value->tv_sec != LONG_SECONDS || value->tv_nsec != 987654321)
		test_fail("libc wait modified the caller timeout");
}

static void absolute_timers(clockid_t clock)
{
	struct timespec now;
	if (clock_gettime(clock, &now)) test_perror("absolute timer clock");
	/* Under Linux's signed nanosecond ktime limit, with ample room for the
	 * current epoch. Reject an unsuitable clock instead of overflowing it. */
	if (now.tv_sec > 6000000000LL) test_fail("clock too large for long absolute fixture");
	struct itimerspec future = {
		.it_interval = { .tv_sec = LONG_SECONDS, .tv_nsec = 123456789 },
		.it_value = { .tv_sec = now.tv_sec + LONG_SECONDS, .tv_nsec = now.tv_nsec },
	};
	struct itimerspec state, old;
	const struct itimerspec disarm = { 0 };
	struct itimerspec invalid = future;
	invalid.it_value.tv_nsec = 1000000000;
	int fd = timerfd_create(clock, TFD_CLOEXEC | TFD_NONBLOCK);
	if (fd < 0) test_perror("absolute timerfd_create");
	if (timerfd_settime(fd, TFD_TIMER_ABSTIME, &future, NULL) ||
	    timerfd_gettime(fd, &state)) test_perror("absolute timerfd set/get");
	long_timer(&state);
	errno = 0;
	if (timerfd_settime(fd, TFD_TIMER_ABSTIME, &invalid, NULL) != -1 || errno != EINVAL)
		test_fail("timerfd accepted invalid absolute nanoseconds");
	if (timerfd_gettime(fd, &state)) test_perror("timerfd after invalid update");
	long_timer(&state);
	if (timerfd_settime(fd, 0, &disarm, &old)) test_perror("absolute timerfd disarm");
	long_timer(&old);
	timer_t timer;
	struct sigevent event = { .sigev_notify = SIGEV_NONE };
	if (timer_create(clock, &event, &timer)) test_perror("absolute timer_create");
	if (timer_settime(timer, TIMER_ABSTIME, &future, NULL) ||
	    timer_gettime(timer, &state)) test_perror("absolute POSIX timer set/get");
	long_timer(&state);
	errno = 0;
	if (timer_settime(timer, TIMER_ABSTIME, &invalid, NULL) != -1 || errno != EINVAL)
		test_fail("POSIX timer accepted invalid absolute nanoseconds");
	if (timer_gettime(timer, &state)) test_perror("POSIX timer after invalid update");
	long_timer(&state);
	if (timer_settime(timer, 0, &disarm, &old)) test_perror("absolute POSIX timer disarm");
	long_timer(&old);
	if (timer_delete(timer)) test_perror("absolute timer_delete");
	/* Nonzero and already expired: zero would disarm, not expire a timerfd. */
	const struct itimerspec past = { .it_value = { .tv_nsec = 1 } };
	if (timerfd_settime(fd, TFD_TIMER_ABSTIME, &past, NULL))
		test_perror("past absolute timerfd");
	struct pollfd ready = { .fd = fd, .events = POLLIN };
	const struct timespec bounded = { .tv_sec = 5 };
	if (ppoll(&ready, 1, &bounded, NULL) != 1 || ready.revents != POLLIN)
		test_fail("past absolute timerfd did not become readable");
	uint64_t count = 0;
	if (read(fd, &count, sizeof(count)) != sizeof(count) || count != 1)
		test_fail("past absolute timerfd count was not one");
	if (clock_nanosleep(clock, TIMER_ABSTIME, &past.it_value, NULL))
		test_fail("past absolute clock_nanosleep did not return success");
	if (clock_nanosleep(clock, TIMER_ABSTIME, &invalid.it_value, NULL) != EINVAL)
		test_fail("clock_nanosleep did not return EINVAL directly");
	if (close(fd)) test_perror("close absolute timerfd");
}

int main(void)
{
	_Static_assert(sizeof(time_t) == 8, "time ABI requires 64-bit time_t");
	struct timespec now, resolution;
	const clockid_t clocks[] = { CLOCK_REALTIME, CLOCK_MONOTONIC };
	for (size_t i = 0; i < sizeof(clocks) / sizeof(clocks[0]); i++) {
		if (clock_gettime(clocks[i], &now) || clock_getres(clocks[i], &resolution))
			test_perror("clock time and resolution");
		valid_timespec(&now);
		valid_timespec(&resolution);
		if (!resolution.tv_sec && !resolution.tv_nsec)
			test_fail("clock resolution is zero");
	}
	struct itimerspec arm = {
		.it_interval = { .tv_sec = LONG_SECONDS, .tv_nsec = 123456789 },
		.it_value = { .tv_sec = LONG_SECONDS, .tv_nsec = 987654321 },
	};
	struct itimerspec state, old;
	const struct itimerspec disarm = { 0 };
	int fd = timerfd_create(CLOCK_MONOTONIC, TFD_CLOEXEC | TFD_NONBLOCK);
	if (fd < 0) test_perror("timerfd_create");
	if (timerfd_settime(fd, 0, &arm, NULL) || timerfd_gettime(fd, &state))
		test_perror("long timerfd set/get");
	long_timer(&state);
	if (timerfd_settime(fd, 0, &disarm, &old)) test_perror("timerfd disarm old time");
	long_timer(&old);
	if (timerfd_gettime(fd, &state)) test_perror("timerfd get disarmed time");
	if (state.it_value.tv_sec || state.it_value.tv_nsec ||
	    state.it_interval.tv_sec || state.it_interval.tv_nsec)
		test_fail("timerfd did not disarm");
	/* SIGEV_NONE exercises POSIX timer transport without signal handlers or
	 * function-table sentinel workarounds. It does not test signal delivery. */
	timer_t timer;
	struct sigevent event = { .sigev_notify = SIGEV_NONE };
	if (timer_create(CLOCK_MONOTONIC, &event, &timer)) test_perror("timer_create");
	if (timer_settime(timer, 0, &arm, NULL) || timer_gettime(timer, &state))
		test_perror("long POSIX timer set/get");
	long_timer(&state);
	if (timer_settime(timer, 0, &disarm, &old)) test_perror("POSIX timer disarm old time");
	long_timer(&old);
	if (timer_delete(timer)) test_perror("timer_delete");
	/* A short real expiration supplies a ready fd for both long-timeout wait
	 * calls. The runner watchdog bounds failures; no multi-year wait is needed. */
	const struct itimerspec short_arm = { .it_value = { .tv_nsec = 1000000 } };
	if (timerfd_settime(fd, 0, &short_arm, NULL)) test_perror("short timerfd arm");
	struct pollfd pollfd = { .fd = fd, .events = POLLIN };
	const struct timespec bounded = { .tv_sec = 5 };
	if (ppoll(&pollfd, 1, &bounded, NULL) != 1 || pollfd.revents != POLLIN)
		test_fail("timerfd expiration did not become readable");
	sigset_t mask;
	if (sigprocmask(SIG_SETMASK, NULL, &mask)) test_perror("query signal mask");
	struct timespec timeout = { .tv_sec = LONG_SECONDS, .tv_nsec = 987654321 };
	pollfd.revents = 0;
	if (ppoll(&pollfd, 1, &timeout, &mask) != 1 || pollfd.revents != POLLIN)
		test_fail("ppoll long timeout lost ready fd");
	unchanged_timeout(&timeout);
	fd_set readfds;
	if (fd >= FD_SETSIZE) test_fail("timerfd exceeds select fd limit");
	FD_ZERO(&readfds);
	FD_SET(fd, &readfds);
	if (pselect(fd + 1, &readfds, NULL, NULL, &timeout, &mask) != 1 ||
	    !FD_ISSET(fd, &readfds)) test_fail("pselect long timeout lost ready fd");
	unchanged_timeout(&timeout);
	uint64_t count = 0;
	if (read(fd, &count, sizeof(count)) != sizeof(count) || count != 1)
		test_fail("timerfd expiration count was not one");
	errno = 0;
	if (read(fd, &count, sizeof(count)) != -1 || errno != EAGAIN)
		test_fail("consumed nonblocking timerfd did not return EAGAIN");
	const struct timespec zero = { 0 };
	if (ppoll(NULL, 0, &zero, &mask) != 0 ||
	    pselect(0, NULL, NULL, NULL, &zero, &mask) != 0)
		test_fail("zero-timeout wait did not return zero");
	/* clock_nanosleep returns an errno value directly, not -1/errno. */
	int status = clock_nanosleep(CLOCK_MONOTONIC, 0, &zero, NULL);
	if (status) { errno = status; test_perror("zero clock_nanosleep"); }
	if (close(fd)) test_perror("close timerfd");
	for (size_t i = 0; i < sizeof(clocks) / sizeof(clocks[0]); i++)
		absolute_timers(clocks[i]);
	puts("time ABI: relative/absolute timers, expiration and ready-fd waits verified");
	test_pass();
}
