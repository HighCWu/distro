/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <unistd.h>

enum { ALLOC, FREE, IN, OUT, EVENTS };
struct vm_events { uint64_t value[EVENTS]; };

/* Parse the standard proc stream, not word-sized or fabricated counters.
 * Reject missing/duplicate required fields rather than treating them as zero. */
static int read_events(FILE *stream, struct vm_events *events)
{
	static const char *const names[] = { "pgalloc_normal", "pgfree", "pgpgin", "pgpgout" };
	unsigned seen = 0;
	char line[256];
	while (fgets(line, sizeof(line), stream)) {
		char name[128], number[128], extra;
		if (!strchr(line, '\n') || sscanf(line, "%127s %127s %c", name, number, &extra) != 2)
			return -1;
		for (const char *p = number; *p; p++)
			if (*p < '0' || *p > '9') return -1;
		errno = 0;
		unsigned long long value = strtoull(number, NULL, 10);
		if (errno) return -1;
		for (unsigned i = 0; i < EVENTS; i++) {
			if (strcmp(name, names[i])) continue;
			if (seen & (1U << i)) return -1;
			seen |= 1U << i;
			events->value[i] = value;
		}
	}
	return !ferror(stream) && seen == (1U << EVENTS) - 1 ? 0 : -1;
}

static void fail(const char *what)
{
	printf("::vm-test::fail: VM events: %s errno=%d\n", what, errno);
	fflush(stdout);
	exit(1);
}
#define CHECK(ok, what) do { if (!(ok)) fail(what); } while (0)

static struct vm_events snapshot(void)
{
	struct vm_events events = {0};
	FILE *stream = fopen("/proc/vmstat", "r");
	CHECK(stream, "open standard proc counters");
	CHECK(!read_events(stream, &events), "complete numeric event fields");
	CHECK(!fclose(stream), "close proc stream");
	return events;
}

int main(void)
{
	/* This allocation is user linear memory, NOT a kernel VM page event.
	 * The ramfs file below forces actual kernel-managed page allocations. */
	unsigned char *buffer = malloc(65536);
	CHECK(buffer, "I/O buffer");
	memset(buffer, 0x5a, 65536);
	CHECK(!mkdir("/event-memory", 0700), "ramfs mountpoint");
	CHECK(!mount("ramfs", "/event-memory", "ramfs", 0, NULL), "ramfs mount");
	struct vm_events before = snapshot();
	int fd = open("/event-memory/pages", O_CREAT | O_EXCL | O_RDWR, 0600);
	CHECK(fd >= 0, "create kernel page-backed file");
	for (size_t remaining = 32 * 65536; remaining;) {
		size_t count = remaining < 65536 ? remaining : 65536;
		ssize_t written = write(fd, buffer, count);
		if (written < 0 && errno == EINTR) continue;
		CHECK(written > 0, "write kernel page-backed data");
		remaining -= (size_t)written;
	}
	struct vm_events populated = snapshot();
	CHECK(populated.value[ALLOC] > before.value[ALLOC], "real kernel allocation events increase");
	CHECK(lseek(fd, 0, SEEK_SET) == 0, "rewind page-backed file");
	for (size_t remaining = 32 * 65536; remaining;) {
		size_t count = remaining < 65536 ? remaining : 65536;
		ssize_t received = read(fd, buffer, count);
		if (received < 0 && errno == EINTR) continue;
		CHECK(received > 0, "read retained page contents");
		for (ssize_t i = 0; i < received; i++) CHECK(buffer[i] == 0x5a, "page content preserved");
		remaining -= (size_t)received;
	}
	CHECK(!close(fd) && !unlink("/event-memory/pages"), "release retained pages");
	CHECK(!umount("/event-memory") && !rmdir("/event-memory"), "unmount and remove owned mountpoint");
	struct vm_events released = snapshot();
	CHECK(released.value[FREE] > populated.value[FREE], "real kernel release events increase");
	free(buffer);
	puts("vm-events: standard numeric event fields and real kernel page allocation pass");
	puts("vm-events: retained contents, page release and owned mount cleanup pass");
	return 0;
}
