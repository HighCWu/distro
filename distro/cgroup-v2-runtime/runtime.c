// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <unistd.h>

#define CGROUP_ROOT "/sys/fs/cgroup"
#define CGROUP_SUB CGROUP_ROOT "/test_sub"

static void require(int ok, const char *what)
{
	if (ok) return;
	fprintf(stderr, "cgroup-v2-runtime: %s (errno=%d: %s)\n", what, errno,
		strerror(errno));
	exit(1);
}

static void write_str(const char *path, const char *value)
{
	int fd = open(path, O_WRONLY);
	require(fd >= 0, path);
	size_t len = strlen(value);
	ssize_t n = write(fd, value, len);
	require(n == (ssize_t)len, path);
	require(close(fd) == 0, "close cgroup control");
}

static void read_str(const char *path, char *buf, size_t cap)
{
	int fd = open(path, O_RDONLY);
	require(fd >= 0, path);
	ssize_t n = read(fd, buf, cap - 1);
	require(n >= 0, path);
	buf[n] = '\0';
	require(close(fd) == 0, "close cgroup read");
}

struct worker_gate {
	pthread_mutex_t mutex;
	pthread_cond_t cond;
	int ready;
	int release;
};

static void *worker_main(void *arg)
{
	struct worker_gate *gate = (struct worker_gate *)arg;
	volatile uint64_t acc = 0;
	for (uint64_t i = 0; i < 500000ULL; i++) {
		acc += i * 3ULL;
	}
	(void)acc;

	pthread_mutex_lock(&gate->mutex);
	gate->ready++;
	pthread_cond_broadcast(&gate->cond);
	while (!gate->release) {
		pthread_cond_wait(&gate->cond, &gate->mutex);
	}
	pthread_mutex_unlock(&gate->mutex);
	return NULL;
}

int main(void)
{
	setvbuf(stdout, NULL, _IONBF, 0);

	if (mkdir("/sys/fs", 0755) != 0) {
		require(errno == EEXIST, "mkdir /sys/fs");
	}
	if (mkdir(CGROUP_ROOT, 0755) != 0) {
		require(errno == EEXIST, "mkdir /sys/fs/cgroup");
	}
	require(mount("none", CGROUP_ROOT, "cgroup2", 0, NULL) == 0,
		"mount cgroup2");

	char buf[1024];
	read_str(CGROUP_ROOT "/cgroup.controllers", buf, sizeof(buf));
	require(strstr(buf, "pids") != NULL,
		"cgroup.controllers exposes pids");

	read_str(CGROUP_ROOT "/cgroup.subtree_control", buf, sizeof(buf));
	write_str(CGROUP_ROOT "/cgroup.subtree_control", "+pids");

	require(mkdir(CGROUP_SUB, 0755) == 0, "mkdir test_sub");

	write_str(CGROUP_SUB "/pids.max", "16");
	read_str(CGROUP_SUB "/pids.max", buf, sizeof(buf));
	require(strncmp(buf, "16", 2) == 0, "pids.max reads back 16");

	char pid_str[32];
	snprintf(pid_str, sizeof(pid_str), "%ld", (long)getpid());
	write_str(CGROUP_SUB "/cgroup.procs", pid_str);

	read_str("/proc/self/cgroup", buf, sizeof(buf));
	require(strstr(buf, "::/test_sub") != NULL,
		"/proc/self/cgroup shows /test_sub");

	read_str(CGROUP_SUB "/cgroup.events", buf, sizeof(buf));
	require(strstr(buf, "populated 1") != NULL,
		"cgroup.events shows populated 1");

	struct worker_gate gate = {
		.mutex = PTHREAD_MUTEX_INITIALIZER,
		.cond = PTHREAD_COND_INITIALIZER,
		.ready = 0,
		.release = 0,
	};
	pthread_t t1, t2;
	require(pthread_create(&t1, NULL, worker_main, &gate) == 0,
		"pthread_create t1");
	require(pthread_create(&t2, NULL, worker_main, &gate) == 0,
		"pthread_create t2");

	pthread_mutex_lock(&gate.mutex);
	while (gate.ready < 2) {
		pthread_cond_wait(&gate.cond, &gate.mutex);
	}
	pthread_mutex_unlock(&gate.mutex);

	read_str(CGROUP_SUB "/pids.current", buf, sizeof(buf));
	long cur_pids = strtol(buf, NULL, 10);
	require(cur_pids >= 3, "pids.current reflects main + 2 worker threads");

	pthread_mutex_lock(&gate.mutex);
	gate.release = 1;
	pthread_cond_broadcast(&gate.cond);
	pthread_mutex_unlock(&gate.mutex);
	require(pthread_join(t1, NULL) == 0 && pthread_join(t2, NULL) == 0,
		"pthread_join workers");

	read_str(CGROUP_SUB "/cpu.stat", buf, sizeof(buf));
	require(strlen(buf) > 0, "cpu.stat readable");

	write_str(CGROUP_ROOT "/cgroup.procs", pid_str);
	read_str(CGROUP_SUB "/cgroup.events", buf, sizeof(buf));
	require(strstr(buf, "populated 0") != NULL,
		"cgroup.events shows populated 0 after migration");

	require(rmdir(CGROUP_SUB) == 0, "rmdir test_sub");
	write_str(CGROUP_ROOT "/cgroup.subtree_control", "-pids");
	require(umount(CGROUP_ROOT) == 0, "umount cgroup2");

	puts("cgroup v2 runtime: pids controller, migration, threads, events and cleanup pass");
	return 0;
}
