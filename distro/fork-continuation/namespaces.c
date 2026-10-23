/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#ifndef __wasm__
#error This changes only namespaces in an isolated Wasm machine, never the build host
#endif
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <net/if.h>
#include <poll.h>
#include <sched.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mount.h>
#include <sys/msg.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/utsname.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static _Noreturn void fail(const char *what)
{
	printf("::vm-test::fail: namespaces: %s errno=%d\n", what, errno);
	fflush(stdout);
	for (;;) sched_yield();
}

static void require(int ok, const char *what)
{
	if (!ok) fail(what);
}

static int namespace_fd(const char *name)
{
	char path[96];
	int n = snprintf(path, sizeof path, "/proc/self/ns/%s", name);
	require(n > 0 && n < (int)sizeof path, "namespace path length");
	int fd = open(path, O_RDONLY | O_CLOEXEC);
	require(fd >= 0, "open namespace handle");
	return fd;
}

static void distinct(int old, int fresh)
{
	struct stat a, b;
	require(fstat(old, &a) == 0 && fstat(fresh, &b) == 0 &&
	        a.st_dev == b.st_dev && a.st_ino != b.st_ino, "distinct namespace identities");
}

static void uts(void)
{
	struct utsname before, after;
	int original = namespace_fd("uts");
	require(uname(&before) == 0 && unshare(CLONE_NEWUTS) == 0, "unshare UTS");
	int fresh = namespace_fd("uts");
	distinct(original, fresh);
	const char label[] = "linux-wasm-isolated";
	require(sethostname(label, sizeof label - 1) == 0 && uname(&after) == 0 &&
	        !strcmp(after.nodename, label), "isolated hostname");
	require(setns(original, CLONE_NEWUTS) == 0 && uname(&after) == 0 &&
	        !strcmp(after.nodename, before.nodename), "restore original UTS");
	require(setns(fresh, 0) == 0 && uname(&after) == 0 && !strcmp(after.nodename, label),
	        "re-enter UTS by namespace fd");
	require(setns(original, CLONE_NEWNET) == -1 && errno == EINVAL &&
	        setns(-1, CLONE_NEWUTS) == -1 && errno == EBADF, "setns type and descriptor errors");
	require(setns(original, CLONE_NEWUTS) == 0 && close(original) == 0 && close(fresh) == 0,
	        "UTS restoration and handle cleanup");
	puts("namespaces: UTS identity, hostname isolation, setns and error recovery pass");
}

static void mounts(void)
{
	int original = namespace_fd("mnt");
	require(mkdir("/ns-mount", 0700) == 0 && unshare(CLONE_NEWNS) == 0 &&
	        mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL) == 0, "private mount namespace");
	int fresh = namespace_fd("mnt");
	distinct(original, fresh);
	/* ramfs requires no MMU-backed tmpfs mappings. */
	require(mount("none", "/ns-mount", "ramfs", 0, NULL) == 0, "private ramfs mount");
	int fd = open("/ns-mount/token", O_CREAT | O_WRONLY | O_CLOEXEC, 0600);
	require(fd >= 0 && write(fd, "M", 1) == 1 && close(fd) == 0, "private mounted file");
	require(setns(original, CLONE_NEWNS) == 0 && chdir("/") == 0 &&
	        open("/ns-mount/token", O_RDONLY) == -1 && errno == ENOENT, "mount hidden from original namespace");
	require(setns(fresh, CLONE_NEWNS) == 0 && chdir("/") == 0, "re-enter private mounts");
	char value = 0;
	fd = open("/ns-mount/token", O_RDONLY | O_CLOEXEC);
	require(fd >= 0 && read(fd, &value, 1) == 1 && value == 'M' && close(fd) == 0 &&
	        umount("/ns-mount") == 0, "mounted data survives namespace switch");
	require(setns(original, CLONE_NEWNS) == 0 && chdir("/") == 0 && rmdir("/ns-mount") == 0 &&
	        close(original) == 0 && close(fresh) == 0, "mount namespace cleanup");
	puts("namespaces: private mount visibility, re-entry, data and unmount cleanup pass");
}

struct message { long type; char value; };
static void send_token(int queue, char value)
{
	struct message m = { .type = 1, .value = value };
	require(msgsnd(queue, &m, 1, 0) == 0, "send namespaced message");
}
static void receive_token(int queue, char value)
{
	struct message m = {0};
	require(msgrcv(queue, &m, 1, 0, IPC_NOWAIT) == 1 && m.type == 1 && m.value == value,
	        "receive message from correct IPC namespace");
}
static void ipc(void)
{
	int original = namespace_fd("ipc");
	int old_queue = msgget(IPC_PRIVATE, 0600);
	require(old_queue >= 0 && unshare(CLONE_NEWIPC) == 0, "unshare IPC");
	int fresh = namespace_fd("ipc");
	distinct(original, fresh);
	struct message m;
	require(msgrcv(old_queue, &m, 1, 0, IPC_NOWAIT) == -1 && errno == EINVAL,
	        "old IPC object absent in empty namespace");
	int new_queue = msgget(IPC_PRIVATE, 0600);
	require(new_queue >= 0, "new IPC queue");
	send_token(new_queue, 'C');
	require(setns(original, CLONE_NEWIPC) == 0, "restore IPC namespace");
	require(msgrcv(old_queue, &m, 1, 0, IPC_NOWAIT) == -1 && errno == ENOMSG,
	        "original IPC queue remains empty");
	send_token(old_queue, 'P'); receive_token(old_queue, 'P');
	require(setns(fresh, CLONE_NEWIPC) == 0, "re-enter IPC namespace");
	receive_token(new_queue, 'C');
	require(msgctl(new_queue, IPC_RMID, NULL) == 0 && setns(original, CLONE_NEWIPC) == 0 &&
	        msgctl(old_queue, IPC_RMID, NULL) == 0 && close(original) == 0 && close(fresh) == 0,
	        "IPC object and namespace cleanup");
	puts("namespaces: IPC object isolation, independent messages and queue cleanup pass");
}

static void loopback_up(void)
{
	int fd = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
	struct ifreq request = { .ifr_name = "lo" };
	require(fd >= 0 && ioctl(fd, SIOCGIFFLAGS, &request) == 0, "namespace loopback flags");
	request.ifr_flags |= IFF_UP;
	require(ioctl(fd, SIOCSIFFLAGS, &request) == 0 && close(fd) == 0, "namespace loopback up");
}
static int udp_socket(void)
{
	int fd = socket(AF_INET, SOCK_DGRAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
	require(fd >= 0, "namespaced UDP socket"); return fd;
}
static void receive_byte(int fd, char expected)
{
	struct pollfd p = { .fd = fd, .events = POLLIN };
	char value;
	require(poll(&p, 1, 5000) == 1 && (p.revents & POLLIN) &&
	        recv(fd, &value, 1, 0) == 1 && value == expected, "namespace-specific UDP data");
}
static void network(void)
{
	int original = namespace_fd("net");
	loopback_up();
	int old_receiver = udp_socket(), old_sender = udp_socket();
	struct sockaddr_in address = { .sin_family = AF_INET, .sin_addr.s_addr = htonl(INADDR_LOOPBACK) };
	socklen_t length = sizeof address;
	require(bind(old_receiver, (void *)&address, sizeof address) == 0 &&
	        getsockname(old_receiver, (void *)&address, &length) == 0 && unshare(CLONE_NEWNET) == 0,
	        "bind original endpoint and unshare network");
	int fresh = namespace_fd("net"); distinct(original, fresh);
	loopback_up();
	int new_receiver = udp_socket(), new_sender = udp_socket();
	require(bind(new_receiver, (void *)&address, sizeof address) == 0,
	        "same UDP address independently binds in new namespace");
	require(sendto(new_sender, "C", 1, 0, (void *)&address, sizeof address) == 1 &&
	        sendto(old_sender, "P", 1, 0, (void *)&address, sizeof address) == 1,
	        "socket fds retain their original network namespace");
	receive_byte(new_receiver, 'C'); receive_byte(old_receiver, 'P');
	require(setns(original, CLONE_NEWNET) == 0 && close(new_receiver) == 0 && close(new_sender) == 0 &&
	        close(old_receiver) == 0 && close(old_sender) == 0 && close(original) == 0 && close(fresh) == 0,
	        "network namespace descriptor cleanup");
	puts("namespaces: network endpoint isolation, same-address bind and fd ownership pass");
}

static int64_t clock_difference(clockid_t selected)
{
	struct timespec adjusted, real;
	require(clock_gettime(selected, &adjusted) == 0 && clock_gettime(CLOCK_REALTIME, &real) == 0,
	        "time namespace clocks");
	return ((int64_t)adjusted.tv_sec - real.tv_sec) * 1000000000 + adjusted.tv_nsec - real.tv_nsec;
}
static void time_namespace(void)
{
	int original = namespace_fd("time");
	int64_t baseline = clock_difference(CLOCK_MONOTONIC);
	int64_t raw_baseline = clock_difference(CLOCK_MONOTONIC_RAW);
	require(unshare(CLONE_NEWTIME) == 0, "unshare time-for-children namespace");
	int fresh = namespace_fd("time_for_children"); distinct(original, fresh);
	int fd = open("/proc/self/timens_offsets", O_WRONLY | O_CLOEXEC);
	const char offset[] = "monotonic 3 0\n";
	require(fd >= 0 && write(fd, offset, sizeof offset - 1) == sizeof offset - 1 && close(fd) == 0,
	        "set new time namespace monotonic offset");
	require(setns(fresh, CLONE_NEWTIME) == 0, "join new time namespace");
	fd = open("/proc/self/timens_offsets", O_WRONLY | O_CLOEXEC);
	require(fd >= 0 && write(fd, offset, sizeof offset - 1) == -1 && errno == EACCES && close(fd) == 0,
	        "offsets freeze when first task joins without a vDSO");
	int64_t shifted = clock_difference(CLOCK_MONOTONIC) - baseline;
	int64_t raw_shifted = clock_difference(CLOCK_MONOTONIC_RAW) - raw_baseline;
	require(shifted >= INT64_C(2000000000) && shifted <= INT64_C(4000000000) &&
	        raw_shifted >= INT64_C(2000000000) && raw_shifted <= INT64_C(4000000000),
	        "both monotonic clocks gain namespace offset while realtime does not");
	require(setns(original, CLONE_NEWTIME) == 0, "restore original time namespace");
	shifted = clock_difference(CLOCK_MONOTONIC) - baseline;
	raw_shifted = clock_difference(CLOCK_MONOTONIC_RAW) - raw_baseline;
	require(shifted > -INT64_C(1000000000) && shifted < INT64_C(1000000000) &&
	        raw_shifted > -INT64_C(1000000000) && raw_shifted < INT64_C(1000000000) &&
	        close(original) == 0 && close(fresh) == 0, "time namespace restoration and cleanup");
	puts("namespaces: monotonic/raw offsets, frozen offsets, realtime independence and restoration pass");
}

static void pid_namespace(void)
{
	int original = namespace_fd("pid");
	pid_t parent = getpid();
	require(unshare(CLONE_NEWPID) == 0 && getpid() == parent, "PID namespace changes only future children");
	int fresh = namespace_fd("pid_for_children"); distinct(original, fresh);
	pid_t child = fork();
	require(child >= 0, "single-thread fork into PID namespace");
	if (!child) _exit(getpid() == 1 && getppid() == 0 ? 42 : 124);
	int status = 0;
	pid_t waited;
	do waited = waitpid(child, &status, 0); while (waited < 0 && errno == EINTR);
	require(waited == child && WIFEXITED(status) && WEXITSTATUS(status) == 42 &&
	        getpid() == parent && setns(original, CLONE_NEWPID) == 0,
	        "namespaced init exits without killing parent and is reaped once");
	require(waitpid(child, &status, WNOHANG) == -1 && errno == ECHILD &&
	        close(original) == 0 && close(fresh) == 0, "PID namespace cleanup");
	puts("namespaces: child PID one, invisible parent, exit and parent wait identity pass");
}

int main(void)
{
	require(mkdir("/proc", 0555) == 0 || errno == EEXIST, "proc directory");
	require(mount("proc", "/proc", "proc", 0, NULL) == 0, "mount proc");
	uts(); mounts(); ipc(); network(); time_namespace(); pid_namespace();
	require(umount("/proc") == 0, "unmount proc after namespace handles close");
	puts("::vm-test::pass");
	fflush(stdout);
	for (;;) sched_yield();
}
