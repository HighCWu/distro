#define _GNU_SOURCE
#include "test.h"

#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdlib.h>
#include <sys/signalfd.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

#define PERSISTENT_ITERATIONS 48
#define CHURN_PROCESSES 24
#define CHILD_STACK_SIZE (64 * 1024)

enum message_stage {
	MESSAGE_READY = 1,
	MESSAGE_SIGNAL = 2,
	MESSAGE_ERROR = 3,
};

struct message {
	int stage;
	int iteration;
	int signal_number;
	int error_number;
};

struct child_args {
	pid_t parent;
	int messages[2];
	int first_iteration;
	int iterations;
	int use_socket;
	char socket_path[sizeof(((struct sockaddr_un *)0)->sun_path)];
};

static const int test_signals[] = { SIGINT, SIGALRM, SIGTERM };

/*
 * The parent sends the next signal as soon as it consumes an acknowledgement.
 * Depending on scheduling, that signal races with the child's next poll and
 * therefore exercises both already-pending and wait-queue wakeup paths.
 */

static int send_message(int fd, int stage, int iteration, int signal_number,
			int error_number)
{
	struct message message = {
		.stage = stage,
		.iteration = iteration,
		.signal_number = signal_number,
		.error_number = error_number,
	};

	return write(fd, &message, sizeof(message)) == sizeof(message) ? 0 : -1;
}

static int child_error(int fd, int iteration, int operation, int error_number)
{
	(void)send_message(fd, MESSAGE_ERROR, iteration, operation, error_number);
	return 100 + operation;
}

static int child(void *opaque)
{
	struct child_args *args = opaque;
	struct signalfd_siginfo info;
	sigset_t mask;
	int listener = -1;
	int signal_fd;

	close(args->messages[0]);
	if (sigemptyset(&mask) == -1)
		return child_error(args->messages[1], -1, 1, errno);
	for (size_t i = 0; i < sizeof(test_signals) / sizeof(test_signals[0]); i++)
		if (sigaddset(&mask, test_signals[i]) == -1)
			return child_error(args->messages[1], -1, 2, errno);
	if (sigprocmask(SIG_BLOCK, &mask, NULL) == -1)
		return child_error(args->messages[1], -1, 3, errno);

	signal_fd = signalfd(-1, &mask, SFD_CLOEXEC);
	if (signal_fd == -1)
		return child_error(args->messages[1], -1, 4, errno);
	if (args->use_socket) {
		struct sockaddr_un address = { .sun_family = AF_UNIX };

		memcpy(address.sun_path, args->socket_path,
		       sizeof(address.sun_path));
		listener = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
		if (listener == -1)
			return child_error(args->messages[1], -1, 5, errno);
		unlink(args->socket_path);
		if (bind(listener, (struct sockaddr *)&address, sizeof(address)) == -1 ||
		    listen(listener, 1) == -1)
			return child_error(args->messages[1], -1, 6, errno);
	}
	if (send_message(args->messages[1], MESSAGE_READY, -1, 0, 0) == -1)
		return 107;

	for (int offset = 0; offset < args->iterations; offset++) {
		int iteration = args->first_iteration + offset;
		int expected = test_signals[iteration %
			(sizeof(test_signals) / sizeof(test_signals[0]))];
		struct pollfd poll_fd = {
			.fd = signal_fd,
			.events = POLLIN,
		};
		int result;

		if (args->use_socket) {
			struct pollfd socket_poll[2] = {
				{ .fd = signal_fd, .events = POLLIN },
				{ .fd = listener, .events = POLLIN },
			};
			int connection;
			int request;

			result = poll(socket_poll, 2, 5000);
			if (result != 1 || !(socket_poll[1].revents & POLLIN) ||
			    socket_poll[0].revents)
				return child_error(args->messages[1], iteration, 8,
						   result < 0 ? errno : ETIMEDOUT);
			connection = accept4(listener, NULL, NULL, SOCK_CLOEXEC);
			if (connection == -1)
				return child_error(args->messages[1], iteration, 9, errno);
			if (read(connection, &request, sizeof(request)) != sizeof(request) ||
			    request != iteration ||
			    write(connection, &request, sizeof(request)) != sizeof(request)) {
				int saved_errno = errno ? errno : EPROTO;

				close(connection);
				return child_error(args->messages[1], iteration, 10,
						   saved_errno);
			}
			close(connection);
		}

		errno = 0;
		result = poll(&poll_fd, 1, 5000);
		if (result != 1 || !(poll_fd.revents & POLLIN))
			return child_error(args->messages[1], iteration, 11,
					   result < 0 ? errno : ETIMEDOUT);
		if (read(signal_fd, &info, sizeof(info)) != sizeof(info))
			return child_error(args->messages[1], iteration, 12, errno);
		if ((int)info.ssi_signo != expected ||
		    (pid_t)info.ssi_pid != args->parent || info.ssi_code != SI_USER)
			return child_error(args->messages[1], iteration, 13, EPROTO);
		if (send_message(args->messages[1], MESSAGE_SIGNAL, iteration,
				 expected, 0) == -1)
			return 114;
	}

	if (listener >= 0) {
		close(listener);
		unlink(args->socket_path);
	}
	close(signal_fd);
	close(args->messages[1]);
	return 0;
}

static struct message receive_message(int fd, int expected_iteration,
				      int expected_signal)
{
	struct pollfd poll_fd = {
		.fd = fd,
		.events = POLLIN,
	};
	struct message message;
	char failure[256];
	int result;

	errno = 0;
	result = poll(&poll_fd, 1, 5000);
	if (result != 1 || !(poll_fd.revents & (POLLIN | POLLHUP))) {
		snprintf(failure, sizeof(failure),
			 "signalfd message timeout at iteration %d signal %d: %s",
			 expected_iteration, expected_signal,
			 result < 0 ? strerror(errno) : "no readable event");
		test_fail(failure);
	}
	if (read(fd, &message, sizeof(message)) != sizeof(message)) {
		snprintf(failure, sizeof(failure),
			 "signalfd message pipe closed at iteration %d signal %d",
			 expected_iteration, expected_signal);
		test_fail(failure);
	}
	if (message.stage == MESSAGE_ERROR) {
		snprintf(failure, sizeof(failure),
			 "signalfd child operation %d failed at iteration %d: %s",
			 message.signal_number, message.iteration,
			 strerror(message.error_number));
		test_fail(failure);
	}

	return message;
}

static void request_child(const char *path, int iteration)
{
	struct sockaddr_un address = { .sun_family = AF_UNIX };
	int response = -1;
	int connection;

	memcpy(address.sun_path, path, sizeof(address.sun_path));
	connection = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
	if (connection == -1)
		test_perror("create signalfd child client socket");
	if (connect(connection, (struct sockaddr *)&address, sizeof(address)) == -1)
		test_perror("connect signalfd child socket");
	if (write(connection, &iteration, sizeof(iteration)) != sizeof(iteration) ||
	    read(connection, &response, sizeof(response)) != sizeof(response) ||
	    response != iteration)
		test_fail("signalfd child socket exchange failed");
	close(connection);
}

static void run_child(int first_iteration, int iterations, int use_socket)
{
	struct child_args args = {
		.parent = getpid(),
		.first_iteration = first_iteration,
		.iterations = iterations,
		.use_socket = use_socket,
	};
	struct message message;
	char failure[256];
	char *stack;
	pid_t pid;
	int status;

	stack = malloc(CHILD_STACK_SIZE);
	if (!stack)
		test_perror("allocate signalfd child stack");
	if (use_socket) {
		snprintf(args.socket_path, sizeof(args.socket_path),
			 "/tmp/signalfd-cross-process-%d.sock", first_iteration);
		unlink(args.socket_path);
	}
	if (pipe(args.messages) == -1)
		test_perror("create signalfd message pipe");

	pid = clone(child, stack + CHILD_STACK_SIZE, SIGCHLD, &args);
	if (pid == -1)
		test_perror("clone signalfd child");
	close(args.messages[1]);

	message = receive_message(args.messages[0], -1, 0);
	if (message.stage != MESSAGE_READY)
		test_fail("signalfd child did not publish readiness");

	for (int offset = 0; offset < iterations; offset++) {
		int iteration = first_iteration + offset;
		int signal_number = test_signals[iteration %
			(sizeof(test_signals) / sizeof(test_signals[0]))];

		if (use_socket)
			request_child(args.socket_path, iteration);
		if (kill(pid, signal_number) == -1)
			test_perror("send signal to signalfd child");
		message = receive_message(args.messages[0], iteration, signal_number);
		if (message.stage != MESSAGE_SIGNAL ||
		    message.iteration != iteration ||
		    message.signal_number != signal_number) {
			snprintf(failure, sizeof(failure),
				 "unexpected signalfd acknowledgement at iteration %d",
				 iteration);
			test_fail(failure);
		}
	}

	close(args.messages[0]);
	if (waitpid(pid, &status, 0) == -1)
		test_perror("wait for signalfd child");
	if (!WIFEXITED(status) || WEXITSTATUS(status) != 0)
		test_fail("signalfd child did not exit successfully");
	if (use_socket && (access(args.socket_path, F_OK) != -1 || errno != ENOENT))
		test_fail("signalfd child did not clean its Unix socket");
	free(stack);
}

int main(void)
{
	run_child(0, PERSISTENT_ITERATIONS, 0);
	for (int process = 0; process < CHURN_PROCESSES; process++)
		run_child(PERSISTENT_ITERATIONS + process, 1, 1);

	printf("cross-process signalfd: %d persistent signals and %d Unix-socket "
	       "process lifecycles received\n", PERSISTENT_ITERATIONS,
	       CHURN_PROCESSES);
	test_pass();
}
