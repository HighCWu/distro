/* SPDX-License-Identifier: MIT */
/* Bring-up fixture: use the real executor, lane threads and session process,
 * without requiring a packaged root filesystem or the production root pivot.
 * No protocol or syscall implementation is duplicated here. */
#define main agent_production_main
#include "agent.c"
#undef main

_Static_assert(sizeof(void *) == 8 && sizeof(long) == 8,
	       "runtime fixture must be compiled for native wasm64");

int main(void)
{
	int session_listener;

	signal(SIGPIPE, SIG_IGN);
	if (make_directory("/dev", 0755) ||
	    mount_if_needed("devtmpfs", "/dev", "devtmpfs") ||
	    make_directory("/proc", 0555) ||
	    mount_if_needed("proc", "/proc", "proc") ||
	    make_directory("/tmp", 01777) ||
	    mount_if_needed("tmpfs", "/tmp", "tmpfs")) {
		perror("agent runtime fixture: mounts");
		abort();
	}
	session_listener = listener(session_port, 1);
	if (session_listener == -1) {
		perror("agent runtime fixture: listener");
		abort();
	}
	puts("agent-wasm64-runtime: ready");
	fflush(stdout);
	for (;;) {
		int fd = accept4(session_listener, NULL, NULL, SOCK_CLOEXEC);
		struct session_worker_args args;
		pid_t child, waited;
		int status;

		if (fd == -1) {
			if (errno == EINTR)
				continue;
			perror("agent runtime fixture: accept");
			abort();
		}
		args = (struct session_worker_args) {
			.fd = fd,
			.session_listener = session_listener,
		};
		/* As in production, PID 1 stays single-threaded so clone can
		 * snapshot its address space before the worker starts threads. */
		child = clone(session_worker, session_stack + session_stack_size,
			      SIGCHLD, &args);
		close(fd);
		if (child == -1) {
			perror("agent runtime fixture: clone");
			abort();
		}
		do
			waited = waitpid(child, &status, 0);
		while (waited == -1 && errno == EINTR);
		if (waited != child || !WIFEXITED(status) || WEXITSTATUS(status)) {
			fputs("agent runtime fixture: session failed\n", stderr);
			abort();
		}
		if (cleanup_session_descendants(child))
			abort();
	}
}
