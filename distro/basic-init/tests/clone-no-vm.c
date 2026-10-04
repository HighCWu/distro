#define _GNU_SOURCE
#include "test.h"

#include <sched.h>
#include <signal.h>
#include <stdint.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>

static int global_value = 11;

struct child_args {
	int ready_fd;
	int continue_fd;
	int stack_value;
	int *heap_value;
	size_t page_size;
	unsigned char *mapping;
};

struct child_report {
	uintptr_t mapping;
};

static int child(void *opaque)
{
	struct child_args *args = opaque;
	struct child_report report;
	unsigned char *mapping;
	char byte = 1;

	if (global_value != 11 || *args->heap_value != 22 ||
	    args->stack_value != 33 || args->mapping[0] != 0x41 ||
	    args->mapping[args->page_size - 1] != 0x42)
		return 1;
	mapping = mmap(0, args->page_size, PROT_READ | PROT_WRITE,
		       MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
	if (mapping == MAP_FAILED)
		return 2;
	for (size_t i = 0; i < args->page_size; i++)
		if (mapping[i])
			return 3;
	mapping[0] = 0xc3;
	report.mapping = (uintptr_t)mapping;

	global_value = 101;
	*args->heap_value = 102;
	args->stack_value = 103;
	if (write(args->ready_fd, &report, sizeof(report)) != sizeof(report))
		return 4;
	if (read(args->continue_fd, &byte, sizeof(byte)) != sizeof(byte))
		return 5;

	if (global_value != 101 || *args->heap_value != 102 ||
	    args->stack_value != 103 || mapping[0] != 0xc3 ||
	    args->mapping[0] != 0x41 ||
	    args->mapping[args->page_size - 1] != 0x42)
		return 6;
	if (munmap(mapping, args->page_size) ||
	    munmap(args->mapping, args->page_size))
		return 7;

	return 0;
}

int main(void)
{
	const size_t stack_size = 64 * 1024;
	char *stack = malloc(stack_size);
	int *heap_value = malloc(sizeof(*heap_value));
	size_t page_size = (size_t)sysconf(_SC_PAGESIZE);
	unsigned char *inherited_mapping;
	unsigned char *parent_mapping;
	int ready_pipe[2];
	int continue_pipe[2];
	struct child_args args;
	struct child_report report;
	char byte;
	int status;
	pid_t pid;

	if (!stack || !heap_value)
		test_perror("malloc");
	if (page_size == (size_t)-1 || !page_size)
		test_perror("sysconf(_SC_PAGESIZE)");
	if (pipe(ready_pipe) == -1 || pipe(continue_pipe) == -1)
		test_perror("pipe");
	inherited_mapping = mmap(0, page_size, PROT_READ | PROT_WRITE,
				 MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
	if (inherited_mapping == MAP_FAILED)
		test_perror("inherited mmap");
	inherited_mapping[0] = 0x41;
	inherited_mapping[page_size - 1] = 0x42;

	*heap_value = 22;
	args = (struct child_args) {
		.ready_fd = ready_pipe[1],
		.continue_fd = continue_pipe[0],
		.stack_value = 33,
		.heap_value = heap_value,
		.page_size = page_size,
		.mapping = inherited_mapping,
	};

	pid = clone(child, stack + stack_size, SIGCHLD, &args);
	if (pid == -1)
		test_perror("clone without CLONE_VM");
	if (read(ready_pipe[0], &report, sizeof(report)) != sizeof(report))
		test_perror("read child readiness");
	if (global_value != 11 || *heap_value != 22 || args.stack_value != 33 ||
	    inherited_mapping[0] != 0x41 ||
	    inherited_mapping[page_size - 1] != 0x42)
		test_fail("clone child modified parent memory");
	parent_mapping = mmap(0, page_size, PROT_READ | PROT_WRITE,
			      MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
	if (parent_mapping == MAP_FAILED)
		test_perror("parent mmap after clone");
	if ((uintptr_t)parent_mapping != report.mapping)
		test_fail("clone did not snapshot direct mmap allocator state");
	for (size_t i = 0; i < page_size; i++)
		if (parent_mapping[i])
			test_fail("parent post-clone mmap was not zero filled");
	parent_mapping[0] = 0xd3;

	global_value = 201;
	*heap_value = 202;
	args.stack_value = 203;
	inherited_mapping[0] = 0x71;
	if (write(continue_pipe[1], &byte, sizeof(byte)) != sizeof(byte))
		test_perror("continue child");
	if (waitpid(pid, &status, 0) == -1)
		test_perror("waitpid");
	if (!WIFEXITED(status) || WEXITSTATUS(status) != 0)
		test_fail("clone child did not retain its private memory");
	if (parent_mapping[0] != 0xd3 || inherited_mapping[0] != 0x71 ||
	    inherited_mapping[page_size - 1] != 0x42)
		test_fail("clone child modified parent mmap state");

	if (munmap(parent_mapping, page_size) ||
	    munmap(inherited_mapping, page_size))
		test_perror("parent munmap");
	free(heap_value);
	free(stack);
	test_pass();
}
