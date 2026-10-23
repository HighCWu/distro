// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <pty.h>
#include <sched.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static pid_t owned_pty;
static volatile sig_atomic_t resized;
static _Noreturn void fail(const char *message)
{
	if (owned_pty > 0) {
		int status;
		if (!waitpid(owned_pty, &status, WNOHANG)) {
			kill(owned_pty, SIGKILL);
			while (waitpid(owned_pty, &status, 0) < 0 && errno == EINTR) {}
		}
	}
	dprintf(2, "terminal-process: %s errno=%d\n", message, errno);
	_exit(1);
}
static void require(int ok, const char *message) { if (!ok) fail(message); }
static void write_all(int fd, const void *buffer, size_t length)
{
	const char *bytes = buffer;
	while (length) {
		ssize_t count = write(fd, bytes, length);
		if (count < 0 && errno == EINTR) continue;
		require(count > 0, "complete protocol write");
		bytes += count; length -= count;
	}
}
static void read_exact(int fd, void *buffer, size_t length)
{
	char *bytes = buffer;
	while (length) {
		struct pollfd p = { .fd = fd, .events = POLLIN };
		int ready;
		do ready = poll(&p, 1, 5000); while (ready < 0 && errno == EINTR);
		require(ready > 0, "bounded protocol read");
		ssize_t count = read(fd, bytes, length);
		if (count < 0 && errno == EINTR) continue;
		require(count > 0, "complete protocol read");
		bytes += count; length -= count;
	}
}
static void line(int fd, const char *expected)
{
	char buffer[80], byte;
	size_t count = 0;
	for (;;) {
		read_exact(fd, &byte, 1);
		if (byte == '\r') continue;
		if (byte == '\n') break;
		require(count + 1 < sizeof buffer, "bounded terminal line");
		buffer[count++] = byte;
	}
	buffer[count] = 0;
	require(!strcmp(buffer, expected), "terminal protocol contents");
}
static void winch(int sig) { if (sig == SIGWINCH) resized = 1; }
static void terminal(void)
{
	struct winsize initial = { .ws_row = 24, .ws_col = 80 };
	int master = -1, status;
	pid_t child = forkpty(&master, NULL, NULL, &initial);
	require(child >= 0, "existing forkpty");
	if (!child) {
		struct winsize size;
		pid_t self = getpid();
		require(getsid(0) == self && getpgrp() == self && tcgetpgrp(0) == self,
			"login_tty session and foreground process group");
		require(isatty(0) && isatty(1) && isatty(2), "slave installed on standard descriptors");
		require(!ioctl(0, TIOCGWINSZ, &size) && size.ws_row == 24 && size.ws_col == 80,
			"initial terminal window size");
		struct sigaction action = { .sa_handler = winch };
		sigemptyset(&action.sa_mask);
		require(!sigaction(SIGWINCH, &action, NULL), "window signal handler");
		sigset_t block, oldmask, waitmask;
		sigemptyset(&block); sigaddset(&block, SIGWINCH);
		require(!sigprocmask(SIG_BLOCK, &block, &oldmask), "block resize before handshake");
		waitmask = oldmask; sigdelset(&waitmask, SIGWINCH);
		write_all(1, "READY\n", 6);
		char input[5];
		read_exact(0, input, sizeof input);
		require(!memcmp(input, "ping\n", sizeof input), "canonical terminal input");
		write_all(1, "PONG\n", 5);
		while (!resized) sigsuspend(&waitmask);
		require(!sigprocmask(SIG_SETMASK, &oldmask, NULL), "restore terminal signal mask");
		require(!ioctl(0, TIOCGWINSZ, &size) && size.ws_row == 37 && size.ws_col == 103,
			"updated terminal window size");
		write_all(1, "WINCH\n", 6);
		_exit(23);
	}
	owned_pty = child;
	line(master, "READY");
	write_all(master, "ping\n", 5);
	line(master, "ping"); /* Default canonical mode echoes input. */
	line(master, "PONG");
	struct winsize updated = { .ws_row = 37, .ws_col = 103 };
	require(!ioctl(master, TIOCSWINSZ, &updated), "resize master and signal foreground group");
	line(master, "WINCH");
	require(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 23,
		"terminal child exit and reap");
	owned_pty = 0;
	require(!close(master), "terminal master cleanup");
	puts("terminal-process: forkpty login_tty session, foreground group, canonical I/O and SIGWINCH pass");
	fflush(stdout);
}
struct daemon_report { pid_t pid, session, group, parent; int null_stdio, root_cwd; };
static void detached(void)
{
	int pipefd[2], old_subreaper = 0;
	require(!syscall(SYS_prctl, (long)PR_GET_CHILD_SUBREAPER, (long)&old_subreaper, 0L, 0L, 0L, 0L), "read subreaper");
	require(!syscall(SYS_prctl, (long)PR_SET_CHILD_SUBREAPER, 1L, 0L, 0L, 0L, 0L), "enable subreaper");
	require(!pipe(pipefd), "daemon report pipe");
	pid_t parent = getpid(), helper = fork();
	require(helper >= 0, "daemon launcher fork");
	if (!helper) {
		close(pipefd[0]);
		require(!chdir("/dev/pts"), "daemon starts away from root");
		require(!daemon(0, 0), "existing double-fork daemon");
		struct daemon_report report = { .pid = getpid(), .session = getsid(0), .group = getpgrp() };
		struct timespec limit, now;
		require(!clock_gettime(CLOCK_MONOTONIC, &limit), "adoption deadline");
		limit.tv_sec += 5;
		while (getppid() != parent) {
			require(!clock_gettime(CLOCK_MONOTONIC, &now) && now.tv_sec < limit.tv_sec, "subreaper adoption");
			sched_yield();
		}
		report.parent = getppid();
		struct stat expected, current;
		require(!stat("/dev/null", &expected), "null device metadata");
		report.null_stdio = 1;
		for (int fd = 0; fd < 3; fd++)
			if (fstat(fd, &current) || !S_ISCHR(current.st_mode) || current.st_rdev != expected.st_rdev)
				report.null_stdio = 0;
		char cwd[8];
		report.root_cwd = getcwd(cwd, sizeof cwd) && !strcmp(cwd, "/");
		write_all(pipefd[1], &report, sizeof report);
		close(pipefd[1]);
		_exit(25);
	}
	close(pipefd[1]);
	struct daemon_report report;
	read_exact(pipefd[0], &report, sizeof report);
	require(!close(pipefd[0]), "daemon report cleanup");
	require(report.pid > 0 && report.pid != helper && report.pid != report.session &&
		report.group == report.session && report.parent == parent && report.null_stdio && report.root_cwd,
		"daemon double-fork session, adoption, cwd and null standard descriptors");
	int count = 0, zero = 0, final = 0, launcher = 0, status;
	pid_t child;
	while ((child = waitpid(-1, &status, 0)) > 0) {
		require(WIFEXITED(status), "daemon descendants exit normally");
		count++;
		if (WEXITSTATUS(status) == 0) zero++;
		else if (WEXITSTATUS(status) == 25 && child == report.pid) final++;
		else fail("daemon descendant status");
		if (child == helper) launcher++;
	}
	require(errno == ECHILD && count == 3 && zero == 2 && final == 1 && launcher == 1,
		"reap launcher and both daemon descendants once");
	require(!syscall(SYS_prctl, (long)PR_SET_CHILD_SUBREAPER, (long)old_subreaper, 0L, 0L, 0L, 0L), "restore subreaper");
	puts("terminal-process: daemon double fork, session, cwd, stdio and subreaper cleanup pass");
}
int main(void)
{
#ifdef __wasm__
	require(!mkdir("/dev", 0755) || errno == EEXIST, "device directory");
	require(!mount("devtmpfs", "/dev", "devtmpfs", 0, NULL), "device mount");
	require(!mkdir("/dev/pts", 0755) || errno == EEXIST, "pts directory");
	require(!mount("devpts", "/dev/pts", "devpts", 0, "newinstance,ptmxmode=0666,mode=0620"), "pts mount");
#endif
	terminal();
	detached();
#ifdef __wasm__
	require(!umount("/dev/pts") && !umount("/dev"), "terminal mount cleanup");
#endif
	puts("terminal-process: descriptors, descendants and terminal resources released pass");
	puts("::vm-test::pass");
	fflush(stdout);
#ifdef __wasm__
	for (;;) sched_yield();
#else
	return 0;
#endif
}
