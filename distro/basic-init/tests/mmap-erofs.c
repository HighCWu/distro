/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include "test.h"
#include <fcntl.h>
#include <pthread.h>
#include <signal.h>
#include <stdint.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>
#include "mmap-vfs-stats.h"

/* Private test-kernel slot; not mmap UAPI or an SDK interface. */
#define FILE_READ_TEST_NR 255

static long read_mapping(int fd, size_t length, uint64_t offset)
{
	return syscall(FILE_READ_TEST_NR, (unsigned long)fd, (unsigned long)length,
		(unsigned long)(uint32_t)offset, (unsigned long)(uint32_t)(offset >> 32));
}

static void rejected(int fd, size_t length, uint64_t offset, int expected)
{
	errno = 0;
	if (read_mapping(fd, length, offset) != -1 || errno != expected)
		test_fail("EROFS test mapping refusal mismatch");
	mmap_stats_expect(0, 0, 0);
}

static unsigned char *mapped(int fd, size_t length, uint64_t offset)
{
	long result = read_mapping(fd, length, offset);
	if (result == -1) test_perror("EROFS test mapping");
	return (void *)(uintptr_t)result;
}

static void check_bytes(const unsigned char *bytes, size_t rounded,
			size_t offset, size_t source_size)
{
	for (size_t i = 0; i < rounded; i++) {
		unsigned char expected = offset + i < source_size ?
			(unsigned char)((offset + i) * 37 + 11) : 0;
		if (bytes[i] != expected) test_fail("EROFS content or zero tail mismatch");
	}
}

#define READERS 4
#define ROUNDS 8

struct child_copies {
	unsigned char *full, *tail, *fresh;
	size_t page;
	int source, ready[2], hold[2];
	int fatal;
};

static int copy_child(void *opaque)
{
	struct child_copies *copies = opaque;
	size_t page = copies->page;
	if (close(copies->ready[0]) || close(copies->hold[1]) || close(copies->source))
		return 1;
	check_bytes(copies->full, 2 * page, page, 2 * page + 7);
	check_bytes(copies->tail, page, 2 * page, 2 * page + 7);
	check_bytes(copies->fresh, page, page, 2 * page + 7);
	copies->full[0] ^= 0xff;
	copies->tail[0] ^= 0xff;
	copies->fresh[0] ^= 0xff;
	if (munmap(copies->full, 2 * page) || munmap(copies->tail, page) ||
	    munmap(copies->fresh, page)) return 2;
	int fd = open("/snapshot/pattern", O_RDONLY);
	if (fd < 0) return 3;
	long result = read_mapping(fd, 2 * page, page);
	if (result == -1 || close(fd)) return 4;
	unsigned char *bytes = (void *)(uintptr_t)result;
	check_bytes(bytes, 2 * page, page, 2 * page + 7);
	bytes[0] = 0xa5;
	/* Normal exit cleans explicitly; fatal exit intentionally leaves a
	 * published user mapping to the private-mm teardown path. */
	if (!copies->fatal && munmap(bytes, 2 * page)) return 5;
	char marker = 'R';
	if (write(copies->ready[1], &marker, 1) != 1) return 6;
	if (copies->fatal) {
		/* SIGKILL happens after publication, while waiting on this pipe,
		 * not during kernel_read or an asynchronous device operation. */
		(void)read(copies->hold[0], &marker, 1);
		return 7;
	}
	return 0;
}

static void private_copy_lifetime(int fd, size_t page, unsigned char *full,
		unsigned char *tail, unsigned char *fresh)
{
	const size_t stack_size = 64 * 1024;
	char *stack = malloc(stack_size);
	if (!stack) test_perror("allocate EROFS callback stack");
	/* Run before creating pthreads; join alone is not a proof that shared-mm
	 * task teardown is complete enough for a private callback snapshot. */
	for (int fatal = 0; fatal <= 1; fatal++) {
		for (int round = 0; round < ROUNDS; round++) {
			struct child_copies copies = {
				.full = full, .tail = tail, .fresh = fresh,
				.page = page, .source = fd, .fatal = fatal,
			};
			if (pipe(copies.ready) || pipe(copies.hold)) test_perror("EROFS child pipes");
			pid_t pid = clone(copy_child, stack + stack_size, SIGCHLD, &copies);
			if (pid < 0) test_perror("clone EROFS private copies");
			if (close(copies.ready[1]) || close(copies.hold[0]))
				test_perror("close parent unused pipe ends");
			char marker;
			if (read(copies.ready[0], &marker, 1) != 1 || marker != 'R')
				test_fail("EROFS child did not confirm completed copy");
			if (fatal && kill(pid, SIGKILL)) test_perror("kill EROFS copy child");
			int status;
			if (waitpid(pid, &status, 0) != pid) test_perror("reap EROFS copy child");
			if (fatal ? (!WIFSIGNALED(status) || WTERMSIG(status) != SIGKILL) :
			    (!WIFEXITED(status) || WEXITSTATUS(status)))
				test_fail("EROFS copy child exit mismatch");
			if (close(copies.ready[0]) || close(copies.hold[1]))
				test_perror("close parent child pipes");
			mmap_stats_wait(0, 0, 0);
			check_bytes(full, 2 * page, page, 2 * page + 7);
			check_bytes(tail, page, 2 * page, 2 * page + 7);
			check_bytes(fresh, page, page, 2 * page + 7);
			if (lseek(fd, 0, SEEK_CUR) != 23)
				test_fail("EROFS child disturbed parent fd position");
			unsigned char *recovery = mapped(fd, page, page);
			check_bytes(recovery, page, page, 2 * page + 7);
			if (munmap(recovery, page)) test_perror("parent post-child recovery unmap");
			mmap_stats_expect(0, 0, 0);
		}
	}
	free(stack);
}

struct reader {
	int fd;
	unsigned int index;
	size_t page;
	pthread_barrier_t *barrier;
};

static void rendezvous(pthread_barrier_t *barrier)
{
	int result = pthread_barrier_wait(barrier);
	if (result && result != PTHREAD_BARRIER_SERIAL_THREAD)
		test_fail("EROFS reader barrier");
}

static void *concurrent_reader(void *arg)
{
	struct reader *reader = arg;
	size_t page = reader->page;
	for (int round = 0; round < ROUNDS; round++) {
		/* Synchronize before each batch, not inside kernel_read. This does
		 * not claim deterministic overlap of real device I/O. */
		rendezvous(reader->barrier);
		unsigned char *bytes = mapped(reader->fd, 2 * page, page);
		rendezvous(reader->barrier);
		check_bytes(bytes, 2 * page, page, 2 * page + 7);
		/* All copies must exist and be checked before any is modified. */
		rendezvous(reader->barrier);
		bytes[0] = (unsigned char)(0x80 + reader->index);
		rendezvous(reader->barrier);
		if (bytes[0] != (unsigned char)(0x80 + reader->index))
			test_fail("concurrent EROFS copies alias");
		check_bytes(bytes + 1, 2 * page - 1, page + 1, 2 * page + 7);
		/* No thread unmaps until every thread finishes reading its copy. */
		rendezvous(reader->barrier);
		if (munmap(bytes, 2 * page)) test_perror("concurrent EROFS unmap");
		rendezvous(reader->barrier);
	}
	return NULL;
}

static void concurrent_copies(int fd, size_t page)
{
	pthread_barrier_t barrier;
	pthread_t threads[READERS];
	struct reader readers[READERS];
	if (pthread_barrier_init(&barrier, NULL, READERS))
		test_fail("initialize EROFS reader barrier");
	for (unsigned int i = 0; i < READERS; i++) {
		readers[i] = (struct reader){ fd, i, page, &barrier };
		if (pthread_create(&threads[i], NULL, concurrent_reader, &readers[i]))
			test_fail("start EROFS reader");
	}
	for (unsigned int i = 0; i < READERS; i++)
		if (pthread_join(threads[i], NULL)) test_fail("join EROFS reader");
	if (pthread_barrier_destroy(&barrier)) test_fail("destroy EROFS reader barrier");
	/* Gauge selectors are separate reads: query only after all requests end.
	 * File gauge counts controlled anon-inodes, not real EROFS file objects. */
	mmap_stats_wait(0, 0, 0);
	if (lseek(fd, 0, SEEK_CUR) != 23) test_fail("concurrent reads changed file position");
	unsigned char original;
	if (pread(fd, &original, 1, page) != 1 || original != 11)
		test_fail("concurrent private copies wrote back to EROFS");
}

int main(void)
{
	mmap_stats_start();
	size_t page = (size_t)sysconf(_SC_PAGESIZE);
	if (page != 65536) test_fail("unexpected EROFS test page size");
	if (mkdir("/dev", 0755) && errno != EEXIST) test_perror("mkdir dev");
	if (mount("devtmpfs", "/dev", "devtmpfs", 0, NULL) && errno != EBUSY)
		test_perror("mount devtmpfs");
	if (mkdir("/snapshot", 0755) || mkdir("/ordinary", 0755)) test_perror("mkdir mounts");
	if (mount("/dev/vda", "/snapshot", "erofs", MS_RDONLY, NULL) ||
	    mount("/dev/vdb", "/ordinary", "erofs", MS_RDONLY, NULL)) test_perror("mount EROFS");
	int fd = open("/snapshot/pattern", O_RDONLY);
	int ordinary = open("/ordinary/pattern", O_RDONLY);
	int empty = open("/snapshot/empty", O_RDONLY);
	int directory = open("/snapshot", O_RDONLY | O_DIRECTORY);
	int path = open("/snapshot/pattern", O_PATH);
	int init = open("/init", O_RDONLY);
	if (fd < 0 || ordinary < 0 || empty < 0 || directory < 0 || path < 0 || init < 0)
		test_perror("open EROFS fixtures");
	for (int i = 0; i < 8; i++) {
		rejected(ordinary, page, 0, EOPNOTSUPP);
		rejected(init, page, 0, EOPNOTSUPP);
		rejected(directory, page, 0, EOPNOTSUPP);
		rejected(path, page, 0, EBADF);
		rejected(empty, page, 0, EINVAL);
	}
	rejected(-1, page, 0, EBADF);
	rejected(fd, 0, 0, EINVAL);
	rejected(fd, 2 * page + 1, 0, EINVAL);
	rejected(fd, page, 1, EINVAL);
	rejected(fd, page, UINT64_C(1) << 32, EINVAL);
	rejected(fd, page, UINT64_C(1) << 63, EINVAL);
	rejected(fd, 2 * page, 2 * page, EINVAL);
	rejected(fd, page, 3 * page, EINVAL);
	/* Standard mmap must stay closed even for the verified source. */
	errno = 0;
	if (mmap(0, page, PROT_READ | PROT_WRITE, MAP_PRIVATE, fd, 0) != MAP_FAILED ||
	    errno != EINVAL) test_fail("standard file mmap was opened by a fixture");
	if (lseek(fd, 23, SEEK_SET) != 23) test_perror("set EROFS file position");
	unsigned char *full = mapped(fd, 2 * page, page);
	unsigned char *tail = mapped(fd, 1, 2 * page);
	mmap_stats_expect(0, 0, 0);
	if (lseek(fd, 0, SEEK_CUR) != 23) test_fail("mapping read changed EROFS file position");
	check_bytes(full, 2 * page, page, 2 * page + 7);
	check_bytes(tail, page, 2 * page, 2 * page + 7);
	full[0] ^= 0xff;
	if (tail[0] != 11) test_fail("independent EROFS copy modified");
	unsigned char *fresh = mapped(fd, page, page);
	check_bytes(fresh, page, page, 2 * page + 7);
	unsigned char original;
	if (pread(fd, &original, 1, page) != 1 || original != 11)
		test_fail("private copy wrote back to EROFS source");
	full[0] ^= 0xff;
	private_copy_lifetime(fd, page, full, tail, fresh);
	concurrent_copies(fd, page);
	check_bytes(full, 2 * page, page, 2 * page + 7);
	check_bytes(tail, page, 2 * page, 2 * page + 7);
	check_bytes(fresh, page, page, 2 * page + 7);
	if (close(fd)) test_perror("close EROFS source");
	int replacement = open("/ordinary/pattern", O_RDONLY);
	if (replacement != fd) test_fail("EROFS source fd was not reused");
	rejected(replacement, page, 0, EOPNOTSUPP);
	if (close(replacement) || close(ordinary) || close(empty) || close(directory) ||
	    close(path) || close(init)) test_perror("close EROFS fixtures");
	if (umount("/snapshot") || umount("/ordinary")) test_perror("unmount EROFS fixtures");
	/* Published copies have no dependency on fd numbers or the mounted source. */
	check_bytes(full, 2 * page, page, 2 * page + 7);
	check_bytes(tail, page, 2 * page, 2 * page + 7);
	check_bytes(fresh, page, page, 2 * page + 7);
	if (munmap(full, 2 * page) || munmap(tail, page) || munmap(fresh, page))
		test_perror("unmap EROFS private copies");
	mmap_stats_wait(0, 0, 0);
	test_pass();
}
