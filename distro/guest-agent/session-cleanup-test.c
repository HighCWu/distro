/* SPDX-License-Identifier: MIT */
/* Host Linux process test of the same cleanup helper used by PID 1.
 * All signal targets are children created by this test, never host services. */
#define main embedded_agent_main
#include "agent.c"
#undef main
#include <assert.h>

int main(void)
{
	int channel[2], status;
	pid_t worker, descendant, unrelated;

	assert(prctl(PR_SET_CHILD_SUBREAPER, 1) == 0);
	assert(pipe2(channel, O_CLOEXEC) == 0);
	worker = fork();
	assert(worker >= 0);
	if (!worker) {
		close(channel[0]);
		if (setpgid(0, 0))
			_exit(1);
		descendant = fork();
		if (descendant == -1)
			_exit(2);
		if (!descendant) {
			close(channel[1]);
			/* Bound the lifetime even if a broken test leaves this orphan. */
			alarm(10);
			for (;;)
				pause();
		}
		if (write_all(channel[1], &descendant, sizeof(descendant)))
			_exit(3);
		_exit(0);
	}
	close(channel[1]);
	assert(read_all(channel[0], &descendant, sizeof(descendant)) == 0);
	close(channel[0]);
	assert(waitpid(worker, &status, 0) == worker);
	assert(WIFEXITED(status) && WEXITSTATUS(status) == 0);
	assert(kill(descendant, 0) == 0);
	assert(getpgid(descendant) == worker);

	unrelated = fork();
	assert(unrelated >= 0);
	if (!unrelated) {
		alarm(10);
		for (;;)
			pause();
	}
	assert(cleanup_session_descendants(worker) == 0);
	assert(kill(descendant, 0) == -1 && errno == ESRCH);
	assert(waitpid(descendant, NULL, WNOHANG) == -1 && errno == ECHILD);
	assert(kill(unrelated, 0) == 0);
	/* No remaining group is a successful no-op, not an error. */
	assert(cleanup_session_descendants(worker) == 0);
	assert(kill(unrelated, SIGTERM) == 0);
	assert(waitpid(unrelated, &status, 0) == unrelated);
	assert(WIFSIGNALED(status) && WTERMSIG(status) == SIGTERM);
	puts("agent cleanup: adopted group reaped, unrelated process preserved");
	return 0;
}
