#include "test.h"

#include <pthread.h>
#include <unistd.h>

static void cancelled(void *unused)
{
	(void)unused;
	test_pass();
}

struct completed_read_args {
	int write_fd;
	pthread_t target;
};

static void *post_and_cancel_reader(void *opaque)
{
	struct completed_read_args *args = opaque;
	const char byte = 'K';

	usleep(20000);
	if (write(args->write_fd, &byte, 1) != 1)
		return (void *)1;
	if (pthread_cancel(args->target) != 0)
		return (void *)2;
	return NULL;
}

static void test_completed_read_keeps_side_effect(void)
{
	int pipefd[2];
	pthread_t helper;
	void *helper_ret = NULL;
	char byte = 0;

	if (pipe(pipefd) == -1)
		test_perror("pipe");
	struct completed_read_args args = {
		.write_fd = pipefd[1],
		.target = pthread_self(),
	};
	if (pthread_create(&helper, NULL, post_and_cancel_reader, &args) != 0)
		test_fail("pthread_create failed");
	if (read(pipefd[0], &byte, 1) != 1 || byte != 'K')
		test_fail("completed read lost side effect on cancellation");
	if (pthread_setcancelstate(PTHREAD_CANCEL_DISABLE, NULL) != 0)
		test_fail("pthread_setcancelstate disable failed");
	if (pthread_join(helper, &helper_ret) != 0 || helper_ret != NULL)
		test_fail("helper thread failed");
	close(pipefd[0]);
	close(pipefd[1]);
	if (pthread_setcancelstate(PTHREAD_CANCEL_ENABLE, NULL) != 0)
		test_fail("pthread_setcancelstate enable failed");
}

int main(void)
{
	int pipefd[2];
	char byte;

	test_completed_read_keeps_side_effect();
	if (pipe(pipefd) == -1)
		test_perror("pipe");
	pthread_cleanup_push(cancelled, NULL);
	if (pthread_cancel(pthread_self()) != 0)
		test_fail("pthread_cancel failed");
	if (read(pipefd[0], &byte, 1) == -1)
		test_perror("read");
	pthread_cleanup_pop(0);
	test_fail("cancelled read returned");
}
