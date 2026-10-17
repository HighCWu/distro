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

#ifndef FILE_MMAP_SOURCE
#define FILE_MMAP_SOURCE "/snapshot/pattern"
#endif
#define ROUNDS 8
#define READERS 2

/* Only standard APIs; no test syscalls, staging gauges or host-selected fd. */
static void content(const unsigned char *bytes, size_t length, size_t offset, size_t page)
{
	for (size_t i = 0; i < length; i++) {
		unsigned char expected = offset + i < 2 * page + 7 ?
			(unsigned char)((offset + i) * 37 + 11) : 0;
		if (bytes[i] != expected) test_fail("standard mmap lifetime content mismatch");
	}
}

static unsigned char *mapped(int fd, size_t page, int prot)
{
	void *bytes = mmap(NULL, 2 * page, prot, MAP_PRIVATE, fd, page);
	if (bytes == MAP_FAILED) test_perror("standard lifetime mmap");
	content(bytes, 2 * page, page, page);
	return bytes;
}

struct child {
	unsigned char *ro, *rw;
	size_t page;
	int fd, ready[2], hold[2], fatal;
};

static int copy_child(void *argument)
{
	struct child *state = argument;
	size_t page = state->page;
	if (close(state->ready[0]) || close(state->hold[1]) || close(state->fd)) return 1;
	content(state->ro, 2 * page, page, page);
	content(state->rw, 2 * page, page, page);
	state->rw[0] ^= 0xff;
	if (munmap(state->ro, 2 * page) || munmap(state->rw, 2 * page)) return 2;
	int fd = open(FILE_MMAP_SOURCE, O_RDONLY);
	if (fd < 0) return 3;
	unsigned char *fresh = mapped(fd, page, PROT_READ | PROT_WRITE);
	if (close(fd)) return 4;
	fresh[0] = 0xa5;
	if (!state->fatal && munmap(fresh, 2 * page)) return 5;
	char marker = 'R';
	if (write(state->ready[1], &marker, 1) != 1) return 6;
	if (state->fatal) {
		/* Deliberately leave the completed user allocation alive for mm
		 * teardown. This does NOT exercise a kill during VFS/device I/O. */
		ssize_t count = read(state->hold[0], &marker, 1);
		return count == 1 ? 7 : 8;
	}
	return 0;
}

static void private_lifetime(int fd, size_t page, unsigned char *ro, unsigned char *rw)
{
	const size_t stack_size = 64 * 1024;
	char *stack = malloc(stack_size);
	if (!stack) test_perror("standard mmap clone stack");
	/* Complete private-mm callbacks before creating any shared-mm threads. */
	for (int fatal = 0; fatal <= 1; fatal++) {
		for (int round = 0; round < ROUNDS; round++) {
			struct child state = { .ro = ro, .rw = rw, .page = page, .fd = fd, .fatal = fatal };
			if (pipe(state.ready) || pipe(state.hold)) test_perror("standard mmap clone pipes");
			pid_t pid = clone(copy_child, stack + stack_size, SIGCHLD, &state);
			if (pid < 0) test_perror("standard mmap private clone");
			if (close(state.ready[1]) || close(state.hold[0])) test_perror("standard mmap pipe ends");
			char marker;
			if (read(state.ready[0], &marker, 1) != 1 || marker != 'R')
				test_fail("standard mmap child publication missing");
			if (fatal && kill(pid, SIGKILL)) test_perror("standard mmap child kill");
			int status;
			if (waitpid(pid, &status, 0) != pid) test_perror("standard mmap child wait");
			if (fatal ? (!WIFSIGNALED(status) || WTERMSIG(status) != SIGKILL) :
			    (!WIFEXITED(status) || WEXITSTATUS(status)))
				test_fail("standard mmap child exit mismatch");
			if (close(state.ready[0]) || close(state.hold[1])) test_perror("standard mmap pipe cleanup");
			content(ro, 2 * page, page, page);
			content(rw, 2 * page, page, page);
			unsigned char *recovery = mapped(fd, page, PROT_READ | PROT_WRITE);
			if (munmap(recovery, 2 * page)) test_perror("standard mmap child recovery");
		}
	}
	free(stack);
	puts("file mmap: standard private clone, normal/fatal exit and recovery verified");
}

struct reader { int fd; unsigned int index; size_t page; pthread_barrier_t *barrier; };
static void rendezvous(pthread_barrier_t *barrier)
{
	int result = pthread_barrier_wait(barrier);
	if (result && result != PTHREAD_BARRIER_SERIAL_THREAD) test_fail("standard mmap barrier");
}

static void *concurrent_reader(void *argument)
{
	struct reader *reader = argument;
	for (int round = 0; round < ROUNDS; round++) {
		rendezvous(reader->barrier);
		unsigned char *bytes = mapped(reader->fd, reader->page, PROT_READ | PROT_WRITE);
		rendezvous(reader->barrier);
		content(bytes, 2 * reader->page, reader->page, reader->page);
		rendezvous(reader->barrier);
		bytes[0] = (unsigned char)(0x80 + reader->index);
		rendezvous(reader->barrier);
		if (bytes[0] != (unsigned char)(0x80 + reader->index)) test_fail("standard mappings alias");
		content(bytes + 1, 2 * reader->page - 1, reader->page + 1, reader->page);
		rendezvous(reader->barrier);
		if (munmap(bytes, 2 * reader->page)) test_perror("standard concurrent unmap");
		rendezvous(reader->barrier);
	}
	return NULL;
}

static void concurrent_copies(int fd, size_t page)
{
	pthread_barrier_t barrier;
	pthread_t threads[READERS];
	struct reader readers[READERS];
	if (pthread_barrier_init(&barrier, NULL, READERS)) test_fail("standard reader barrier init");
	for (unsigned int i = 0; i < READERS; i++) {
		readers[i] = (struct reader){ fd, i, page, &barrier };
		if (pthread_create(&threads[i], NULL, concurrent_reader, &readers[i]))
			test_fail("standard reader create");
	}
	for (unsigned int i = 0; i < READERS; i++)
		if (pthread_join(threads[i], NULL)) test_fail("standard reader join");
	if (pthread_barrier_destroy(&barrier)) test_fail("standard reader barrier destroy");
	puts("file mmap: standard concurrent private copies verified");
}

static void detached_lifetime(unsigned char *ro, unsigned char *rw, size_t page)
{
	content(ro, 2 * page, page, page);
	content(rw, 2 * page, page, page);
	if (munmap(rw, page)) test_perror("standard partial unmap");
	content(rw + page, page, 2 * page, page);
	unsigned char *anonymous = mmap(NULL, page, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
	if (anonymous == MAP_FAILED) test_perror("standard lifetime anonymous recovery");
	for (size_t i = 0; i < page; i++)
		if (anonymous[i]) test_fail("standard lifetime reused memory not zeroed");
	memset(anonymous, 0x5a, page);
	content(rw + page, page, 2 * page, page);
	content(ro, 2 * page, page, page);
	if (munmap(ro, 2 * page) || munmap(rw + page, page) || munmap(anonymous, page))
		test_perror("standard lifetime final cleanup");
	puts("file mmap: standard detached copies, partial unmap and anonymous recovery verified");
}

int main(void)
{
	size_t page = (size_t)sysconf(_SC_PAGESIZE);
	if (page != 65536) test_fail("unexpected standard mmap lifetime page size");
	if (mkdir("/dev", 0755) && errno != EEXIST) test_perror("mkdir dev");
	if (mount("devtmpfs", "/dev", "devtmpfs", 0, NULL) && errno != EBUSY) test_perror("mount devtmpfs");
	if (mkdir("/snapshot", 0755) || mount("/dev/vda", "/snapshot", "erofs", MS_RDONLY, NULL))
		test_perror("mount standard mmap snapshot");
	int fd = open(FILE_MMAP_SOURCE, O_RDONLY);
	if (fd < 0 || lseek(fd, 23, SEEK_SET) != 23) test_perror("open standard mmap snapshot");
	unsigned char *ro = mapped(fd, page, PROT_READ);
	unsigned char *rw = mapped(fd, page, PROT_READ | PROT_WRITE);
	private_lifetime(fd, page, ro, rw);
	concurrent_copies(fd, page);
	content(ro, 2 * page, page, page);
	content(rw, 2 * page, page, page);
	unsigned char original;
	if (pread(fd, &original, 1, page) != 1 || original != 11 || lseek(fd, 0, SEEK_CUR) != 23)
		test_fail("standard lifetime altered source or fd position");
	if (close(fd) || umount("/snapshot")) test_perror("standard mmap source detach");
	detached_lifetime(ro, rw, page);
	puts("file mmap: standard fd close and source unmount verified");
	test_pass();
}
