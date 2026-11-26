/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <linux/genetlink.h>
#include <linux/netlink.h>
#include <linux/taskstats.h>
#include <poll.h>
#include <pthread.h>
#include <sched.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#ifdef TASK_DELAY_RUNTIME
#define ACCOUNTING_LABEL "task-delay-accounting"
#else
#define ACCOUNTING_LABEL "task-io-accounting"
#endif

static void fail(const char *stage)
{
	printf("::vm-test::fail: " ACCOUNTING_LABEL ": %s errno=%d\n", stage, errno);
	fflush(stdout);
	exit(1);
}
#define CHECK(condition, stage) do { if (!(condition)) fail(stage); } while (0)

#ifndef TASK_DELAY_RUNTIME
enum { IO_CALLS = 1031, IO_CHUNK = 64 };
struct counters { uint64_t rchar, wchar, syscr, syscw; };

static struct counters proc_counters(void)
{
	FILE *file = fopen("/proc/self/io", "r");
	CHECK(file, "open /proc/self/io");
	struct counters result = {0};
	unsigned seen = 0;
	char line[256], key[32];
	uint64_t value;
	while (fgets(line, sizeof(line), file)) {
		CHECK(sscanf(line, "%31[^:]: %" SCNu64, key, &value) == 2,
		      "parse /proc/self/io");
		unsigned bit = 0;
		if (!strcmp(key, "rchar")) { result.rchar = value; bit = 1; }
		else if (!strcmp(key, "wchar")) { result.wchar = value; bit = 2; }
		else if (!strcmp(key, "syscr")) { result.syscr = value; bit = 4; }
		else if (!strcmp(key, "syscw")) { result.syscw = value; bit = 8; }
		CHECK(!(seen & bit), "duplicate /proc/self/io counter");
		seen |= bit;
	}
	CHECK(!ferror(file) && !fclose(file) && seen == 15, "complete /proc/self/io counters");
	return result;
}

static struct counters exercise_io(void)
{
	char path[] = "/tmp/task-io-accounting-XXXXXX";
	int fd = mkstemp(path);
	CHECK(fd >= 0 && !unlink(path), "create and unlink private accounting file");
	unsigned char source[IO_CHUNK], target[IO_CHUNK];
	for (size_t i = 0; i < sizeof(source); ++i) source[i] = (unsigned char)(i * 17 + 3);
	struct counters before = proc_counters();
	for (int i = 0; i < IO_CALLS; ++i) {
		ssize_t count;
		do { count = write(fd, source, sizeof(source)); } while (count < 0 && errno == EINTR);
		CHECK(count == (ssize_t)sizeof(source), "controlled descriptor write");
	}
	CHECK(lseek(fd, 0, SEEK_SET) == 0, "rewind accounting file");
	for (int i = 0; i < IO_CALLS; ++i) {
		ssize_t count;
		do { count = read(fd, target, sizeof(target)); } while (count < 0 && errno == EINTR);
		CHECK(count == (ssize_t)sizeof(target) && !memcmp(source, target, sizeof(source)),
		      "controlled descriptor read and content");
	}
	CHECK(!close(fd), "close accounting file");
	struct counters after = proc_counters();
	CHECK(after.rchar >= before.rchar && after.wchar >= before.wchar &&
	      after.syscr >= before.syscr && after.syscw >= before.syscw,
	      "monotonic process I/O counters");
	CHECK(after.rchar - before.rchar >= IO_CALLS * IO_CHUNK &&
	      after.wchar - before.wchar >= IO_CALLS * IO_CHUNK &&
	      after.syscr - before.syscr >= IO_CALLS && after.syscw - before.syscw >= IO_CALLS,
	      "controlled I/O increases rchar wchar syscr syscw");
	puts("task-io-accounting: proc descriptor byte and syscall counters pass");
	return after;
}
#endif

static const struct nlattr *attribute(const void *data, size_t length, unsigned type)
{
	const unsigned char *cursor = data;
	const struct nlattr *found = NULL;
	while (length) {
		CHECK(length >= NLA_HDRLEN, "Netlink attribute header bounds");
		const struct nlattr *entry = (const void *)cursor;
		CHECK(entry->nla_len >= NLA_HDRLEN && entry->nla_len <= length &&
		      (size_t)NLA_ALIGN(entry->nla_len) <= length, "Netlink attribute payload bounds");
		if ((entry->nla_type & NLA_TYPE_MASK) == type) {
			CHECK(!found, "unique Netlink response attribute");
			found = entry;
		}
		size_t size = NLA_ALIGN(entry->nla_len);
		cursor += size;
		length -= size;
	}
	return found;
}

static const void *payload(const struct nlattr *entry, size_t size)
{
	CHECK(entry && entry->nla_len >= NLA_HDRLEN + size, "required Netlink response payload");
	return (const unsigned char *)entry + NLA_HDRLEN;
}

static uint32_t sequence, port;
static union { struct nlmsghdr align; unsigned char bytes[8192]; } response;

static const struct nlmsghdr *query(int fd, uint16_t family, uint8_t command,
				 uint16_t kind, const void *data, size_t length)
{
	union { struct nlmsghdr align; unsigned char bytes[128]; } request = {0};
	CHECK(length <= 64, "bounded Netlink request");
	struct nlmsghdr *header = (void *)request.bytes;
	*header = (struct nlmsghdr){
		.nlmsg_len = NLMSG_HDRLEN + GENL_HDRLEN + NLA_ALIGN(NLA_HDRLEN + length),
		.nlmsg_type = family, .nlmsg_flags = NLM_F_REQUEST,
		.nlmsg_seq = ++sequence, .nlmsg_pid = port,
	};
	struct genlmsghdr *generic = NLMSG_DATA(header);
	*generic = (struct genlmsghdr){.cmd = command, .version = 1};
	struct nlattr *entry = (void *)((unsigned char *)generic + GENL_HDRLEN);
	*entry = (struct nlattr){.nla_len = NLA_HDRLEN + length, .nla_type = kind};
	memcpy((unsigned char *)entry + NLA_HDRLEN, data, length);
	struct sockaddr_nl kernel = {.nl_family = AF_NETLINK};
	CHECK(sendto(fd, request.bytes, header->nlmsg_len, 0,
	             (struct sockaddr *)&kernel, sizeof(kernel)) == (ssize_t)header->nlmsg_len,
	      "send Generic Netlink request");
	struct pollfd ready = {.fd = fd, .events = POLLIN};
	int result;
	do { result = poll(&ready, 1, 5000); } while (result < 0 && errno == EINTR);
	CHECK(result == 1 && (ready.revents & POLLIN) &&
	      !(ready.revents & (POLLERR | POLLNVAL)), "bounded Generic Netlink response");
	struct sockaddr_nl sender = {0};
	struct iovec incoming = {response.bytes, sizeof(response.bytes)};
	struct msghdr reply = {.msg_name = &sender, .msg_namelen = sizeof(sender),
	                     .msg_iov = &incoming, .msg_iovlen = 1};
	ssize_t count = recvmsg(fd, &reply, 0);
	CHECK(count >= (ssize_t)NLMSG_HDRLEN && !(reply.msg_flags & (MSG_TRUNC | MSG_CTRUNC)) &&
	      reply.msg_namelen == sizeof(sender) && sender.nl_family == AF_NETLINK &&
	      sender.nl_pid == 0 && !sender.nl_groups, "kernel Netlink response origin and bounds");
	const struct nlmsghdr *answer = (const void *)response.bytes;
	CHECK(answer->nlmsg_len >= NLMSG_HDRLEN && answer->nlmsg_len <= (size_t)count &&
	      answer->nlmsg_seq == sequence, "Netlink response identity");
	if (answer->nlmsg_type == NLMSG_ERROR) {
		CHECK(answer->nlmsg_len >= NLMSG_LENGTH(sizeof(struct nlmsgerr)), "Netlink error bounds");
		const struct nlmsgerr *error = NLMSG_DATA(answer);
		errno = error->error < 0 ? -error->error : EPROTO;
		fail("Generic Netlink request rejected");
	}
	CHECK(answer->nlmsg_type == family && answer->nlmsg_len >= NLMSG_HDRLEN + GENL_HDRLEN,
	      "Generic Netlink response family");
	return answer;
}

static int open_taskstats(uint16_t *family_id)
{
	int fd = socket(AF_NETLINK, SOCK_RAW | SOCK_CLOEXEC, NETLINK_GENERIC);
	CHECK(fd >= 0, "open Generic Netlink socket");
	struct sockaddr_nl local = {.nl_family = AF_NETLINK};
	CHECK(!bind(fd, (struct sockaddr *)&local, sizeof(local)), "bind Generic Netlink socket");
	socklen_t size = sizeof(local);
	CHECK(!getsockname(fd, (struct sockaddr *)&local, &size) && size == sizeof(local) &&
	      local.nl_pid && !local.nl_groups, "Generic Netlink port identity");
	port = local.nl_pid;
	const struct nlmsghdr *answer = query(fd, GENL_ID_CTRL, CTRL_CMD_GETFAMILY,
		CTRL_ATTR_FAMILY_NAME, TASKSTATS_GENL_NAME, sizeof(TASKSTATS_GENL_NAME));
	const struct genlmsghdr *generic = NLMSG_DATA(answer);
	CHECK(generic->cmd == CTRL_CMD_NEWFAMILY, "TASKSTATS family discovery command");
	const void *attributes = (const unsigned char *)generic + GENL_HDRLEN;
	size_t length = answer->nlmsg_len - NLMSG_HDRLEN - GENL_HDRLEN;
	const struct nlattr *identity = attribute(attributes, length, CTRL_ATTR_FAMILY_ID);
	uint16_t family;
	memcpy(&family, payload(identity, sizeof(family)), sizeof(family));
	CHECK(identity->nla_len == NLA_HDRLEN + sizeof(family) && family >= GENL_START_ALLOC,
	      "TASKSTATS dynamically allocated family ID");
	const struct nlattr *name = attribute(attributes, length, CTRL_ATTR_FAMILY_NAME);
	CHECK(name && name->nla_len == NLA_HDRLEN + sizeof(TASKSTATS_GENL_NAME) &&
	      !memcmp(payload(name, sizeof(TASKSTATS_GENL_NAME)), TASKSTATS_GENL_NAME,
	              sizeof(TASKSTATS_GENL_NAME)), "TASKSTATS discovered family name");
	puts(ACCOUNTING_LABEL ": stock TASKSTATS Generic Netlink family discovery pass");
	*family_id = family;
	return fd;
}

static struct taskstats taskstats_by_tid(int fd, uint16_t family, uint32_t pid, size_t required)
{
	const struct nlmsghdr *answer =
		query(fd, family, TASKSTATS_CMD_GET, TASKSTATS_CMD_ATTR_PID, &pid, sizeof(pid));
	const struct genlmsghdr *generic = NLMSG_DATA(answer);
	CHECK(generic->cmd == TASKSTATS_CMD_NEW && generic->version == TASKSTATS_GENL_VERSION,
	      "TASKSTATS response command and version");
	const void *attributes = (const unsigned char *)generic + GENL_HDRLEN;
	size_t length = answer->nlmsg_len - NLMSG_HDRLEN - GENL_HDRLEN;
	const struct nlattr *aggregate = attribute(attributes, length, TASKSTATS_TYPE_AGGR_PID);
	const void *nested = payload(aggregate, 0);
	length = aggregate->nla_len - NLA_HDRLEN;
	const struct nlattr *process = attribute(nested, length, TASKSTATS_TYPE_PID);
	uint32_t returned_pid;
	memcpy(&returned_pid, payload(process, sizeof(returned_pid)), sizeof(returned_pid));
	CHECK(process->nla_len == NLA_HDRLEN + sizeof(returned_pid) && returned_pid == pid,
	      "TASKSTATS nested PID identity");
	const struct nlattr *accounting = attribute(nested, length, TASKSTATS_TYPE_STATS);
	const void *raw = payload(accounting, required);
	struct taskstats stats = {0};
	size_t available = accounting->nla_len - NLA_HDRLEN;
	memcpy(&stats, raw, available < sizeof(stats) ? available : sizeof(stats));
	CHECK(stats.version >= 2 && stats.ac_pid == pid, "TASKSTATS versioned task identity");
	return stats;
}

#ifndef TASK_DELAY_RUNTIME
static void taskstats_counters(struct counters minimum)
{
	uint16_t family;
	int fd = open_taskstats(&family);
	struct taskstats stats = taskstats_by_tid(fd, family, (uint32_t)getpid(),
		offsetof(struct taskstats, write_syscalls) + sizeof(uint64_t));
	// The upstream extended-accounting exporter rounds these fields down to
	// multiples of 1024, including syscall counts. The workload crosses that
	// threshold; do not mistake this stock export policy for lost accounting.
	CHECK(stats.read_char >= (minimum.rchar / 1024) * 1024 &&
	      stats.write_char >= (minimum.wchar / 1024) * 1024 &&
	      stats.read_syscalls >= (minimum.syscr / 1024) * 1024 &&
	      stats.write_syscalls >= (minimum.syscw / 1024) * 1024 &&
	      stats.read_syscalls && stats.write_syscalls, "TASKSTATS nested process I/O accounting");
	CHECK(!close(fd), "close Generic Netlink descriptor");
	puts("task-io-accounting: nested self PID character and syscall accounting pass");
}
#else
static const char delayacct_path[] = "/proc/sys/kernel/task_delayacct";

static int read_delayacct(void)
{
	FILE *file = fopen(delayacct_path, "r");
	CHECK(file, "open task_delayacct for reading");
	int enabled = -1;
	CHECK(fscanf(file, "%d", &enabled) == 1 && (enabled == 0 || enabled == 1),
	      "read task_delayacct value");
	CHECK(!fclose(file), "close task_delayacct reader");
	return enabled;
}

static void set_delayacct(int enabled)
{
	int fd = open(delayacct_path, O_WRONLY | O_CLOEXEC);
	CHECK(fd >= 0, "open task_delayacct for writing");
	const char value[] = {(char)('0' + enabled), '\n'};
	CHECK(write(fd, value, sizeof(value)) == (ssize_t)sizeof(value),
	      "write task_delayacct value");
	CHECK(!close(fd) && read_delayacct() == enabled, "verify task_delayacct value");
}

enum { WORKERS = 2 };
struct scheduling {
	pthread_mutex_t mutex;
	pthread_cond_t changed;
	unsigned ready, run, done, release;
};
struct participant {
	struct scheduling *state;
	uint32_t tid;
};

static void wait_for_scheduling(struct scheduling *state, const unsigned *phase, unsigned goal)
{
	struct timespec deadline;
	CHECK(!clock_gettime(CLOCK_REALTIME, &deadline), "get thread synchronization deadline");
	deadline.tv_sec += 20;
	while (*phase < goal) {
		CHECK(!pthread_cond_timedwait(&state->changed, &state->mutex, &deadline),
		      "bounded thread synchronization");
	}
}

static void *contend_for_cpu(void *opaque)
{
	struct participant *worker = opaque;
	struct scheduling *state = worker->state;
	pid_t tid = gettid();
	CHECK(tid > 0 && tid != getpid(), "obtain worker TID");
	CHECK(!pthread_mutex_lock(&state->mutex), "lock worker start gate");
	worker->tid = (uint32_t)tid;
	++state->ready;
	CHECK(!pthread_cond_broadcast(&state->changed), "report worker ready");
	wait_for_scheduling(state, &state->run, 1);
	CHECK(!pthread_mutex_unlock(&state->mutex), "unlock worker start gate");

	volatile uint32_t work = worker->tid;
	for (unsigned turn = 0; turn < 64; ++turn) {
		for (unsigned step = 0; step < 4096; ++step) work = work * 1664525u + 1013904223u;
		CHECK(!sched_yield(), "yield to the other runnable thread");
	}

	CHECK(!pthread_mutex_lock(&state->mutex), "lock worker sampling gate");
	++state->done;
	CHECK(!pthread_cond_broadcast(&state->changed), "report worker workload complete");
	wait_for_scheduling(state, &state->release, 1);
	CHECK(!pthread_mutex_unlock(&state->mutex), "unlock worker sampling gate");
	return NULL;
}

static void taskstats_delay(void)
{
	CHECK(sysconf(_SC_NPROCESSORS_ONLN) == 1, "single online CPU for scheduler contention");
	CHECK(read_delayacct() == 0, "task_delayacct is disabled by default");
	set_delayacct(1);
	puts("task-delay-accounting: enabled task_delayacct from its disabled default");

	struct scheduling state = {
		.mutex = PTHREAD_MUTEX_INITIALIZER,
		.changed = PTHREAD_COND_INITIALIZER,
	};
	pthread_t threads[WORKERS];
	struct participant workers[WORKERS];
	for (size_t i = 0; i < WORKERS; ++i) {
		workers[i] = (struct participant){.state = &state};
		CHECK(!pthread_create(&threads[i], NULL, contend_for_cpu, &workers[i]),
		      "create a thread after enabling task_delayacct");
	}
	CHECK(!pthread_mutex_lock(&state.mutex), "lock scheduler start gate");
	wait_for_scheduling(&state, &state.ready, WORKERS);
	CHECK(workers[0].tid != workers[1].tid, "workers have distinct live TIDs");
	state.run = 1;
	CHECK(!pthread_cond_broadcast(&state.changed), "release both worker threads together");
	wait_for_scheduling(&state, &state.done, WORKERS);
	CHECK(!pthread_mutex_unlock(&state.mutex), "unlock scheduler sampling gate");

	uint16_t family;
	int fd = open_taskstats(&family);
	int observed = 0;
	for (size_t i = 0; i < WORKERS; ++i) {
		struct taskstats stats = taskstats_by_tid(fd, family, workers[i].tid,
			offsetof(struct taskstats, ac_pid) + sizeof(stats.ac_pid));
		printf("task-delay-accounting: live TID %" PRIu32 " cpu_count=%" PRIu64
		       " cpu_delay_total=%" PRIu64 "\n",
		       workers[i].tid, (uint64_t)stats.cpu_count, (uint64_t)stats.cpu_delay_total);
		observed |= stats.cpu_count != 0 && stats.cpu_delay_total != 0;
	}
	CHECK(observed, "scheduler wait occurred for a participating live TID");
	CHECK(!close(fd), "close Generic Netlink descriptor");
	puts("task-delay-accounting: live thread scheduler wait count and duration pass");

	CHECK(!pthread_mutex_lock(&state.mutex), "lock worker exit gate");
	state.release = 1;
	CHECK(!pthread_cond_broadcast(&state.changed) && !pthread_mutex_unlock(&state.mutex),
	      "release sampled threads");
	for (size_t i = 0; i < WORKERS; ++i)
		CHECK(!pthread_join(threads[i], NULL), "join sampled thread");
	CHECK(!pthread_cond_destroy(&state.changed) && !pthread_mutex_destroy(&state.mutex),
	      "release synchronization objects");
	set_delayacct(0);
	puts("task-delay-accounting: joined threads and restored task_delayacct");
}
#endif

int main(int argc, char **argv)
{
	setvbuf(stdout, NULL, _IONBF, 0);
#ifdef TASK_DELAY_RUNTIME
	(void)argv;
	CHECK(argc == 1, "target probe takes no arguments");
#else
	CHECK(argc == 1 || (argc == 2 && !strcmp(argv[1], "--proc-only")), "supported fixture arguments");
#endif
#ifdef __wasm__
	CHECK(argc == 1, "target requires complete taskstats acceptance");
	CHECK(!mkdir("/proc", 0755) || errno == EEXIST, "create procfs mountpoint");
	CHECK(!mount("proc", "/proc", "proc", 0, NULL) || errno == EBUSY, "mount procfs");
#endif
#ifdef TASK_DELAY_RUNTIME
#ifndef __wasm__
	// This test changes a global sysctl and belongs in the disposable VM.
	CHECK(0, "run scheduler delay probe in an isolated Linux/Wasm instance");
#endif
	taskstats_delay();
#else
	CHECK(!mkdir("/tmp", 0700) || errno == EEXIST, "create scratch directory");
	struct counters minimum = exercise_io();
	if (argc == 2) {
		puts("task-io-accounting: native proc-only smoke pass (not target acceptance)");
		return 0;
	}
	taskstats_counters(minimum);
#endif
	puts("::vm-test::pass");
#ifdef __wasm__
	for (;;) (void)sched_yield();
#else
	return 0;
#endif
}
