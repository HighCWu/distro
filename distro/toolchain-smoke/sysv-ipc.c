/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <errno.h>
#include <limits.h>
#include <pthread.h>
#include <sched.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/msg.h>
#include <sys/sem.h>
#include <sys/shm.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>
#ifdef __wasm__
#include <spawn.h>
#include <sys/mount.h>
#include <sys/wait.h>
#endif

static int queue = -1, semaphores = -1;
#ifdef __wasm__
static int shared_memory = -1;

/* The generic kernel shmid64_ds wire prefix is 84 bytes on ILP32 and 112 on
 * LP64. Wasm32 libc appends three time64 fields after that prefix, so its
 * complete public struct shmid_ds is 112 bytes in both pointer widths. */
_Static_assert(sizeof(void *) == sizeof(long), "Wasm pointer and syscall word width");
_Static_assert(sizeof(struct ipc_perm) == (sizeof(long) == 4 ? 36 : 48), "generic ipc64_perm ABI");
_Static_assert(offsetof(struct shmid_ds, shm_nattch) == (sizeof(long) == 4 ? 72 : 88),
	       "shmid64_ds wire-prefix field offset");
_Static_assert(sizeof(struct shmid_ds) == 112, "libc time64 shmid_ds ABI");
_Static_assert(sizeof(struct shminfo) == 9 * sizeof(long), "shminfo64 ABI");
_Static_assert(sizeof(struct shm_info) == 6 * sizeof(long), "shm_info ABI");

/* The 32-bit libc shmctl wrapper stages time64 IPC_STAT through a local
 * structure. Use the kernel command directly for fault-order checks so an
 * invalid output address is rejected by the kernel, not libc copyback. */
static long raw_shmctl(int id, int command, void *buffer)
{
	return syscall(SYS_shmctl, (long)id, (long)(command & ~0x100),
	               (long)(uintptr_t)buffer, 0L, 0L, 0L);
}
#endif
union semun { int val; struct semid_ds *buf; unsigned short *array; };
static void cleanup(void)
{
	if (queue >= 0) {
		msgctl(queue, IPC_RMID, NULL);
		queue = -1;
	}
	if (semaphores >= 0) {
		semctl(semaphores, 0, IPC_RMID);
		semaphores = -1;
	}
#ifdef __wasm__
	if (shared_memory >= 0) {
		shmctl(shared_memory, IPC_RMID, NULL);
		shared_memory = -1;
	}
#endif
}
static _Noreturn void fail(const char *what)
{
	int saved_errno = errno;
	cleanup();
	errno = saved_errno;
	printf("::vm-test::fail: sysv-ipc: %s errno=%d\n", what, errno);
	fflush(stdout);
#ifdef __wasm__
	for (;;) sched_yield();
#else
	exit(1);
#endif
}
static void require(int ok, const char *what)
{
	if (!ok) fail(what);
}
#ifdef __wasm__
/* The existing applet reads objects created by another process. No custom API. */
static void applet_report(const char *kind, int id, const char *label)
{
	FILE *capture = tmpfile();
	require(capture != NULL, "applet capture");
	int fd = fileno(capture);
	require(fd > STDERR_FILENO, "capture descriptor");
	char number[32], needle[64], bytes[4096];
	snprintf(number, sizeof(number), "%d", id);
	snprintf(needle, sizeof(needle), "%s=%d", label, id);
	char *argv[] = {"busybox", "ipcs", (char *)kind, "-i", number, NULL};
	posix_spawn_file_actions_t actions;
	require(posix_spawn_file_actions_init(&actions) == 0 &&
	        posix_spawn_file_actions_adddup2(&actions, fd, STDOUT_FILENO) == 0 &&
	        posix_spawn_file_actions_addclose(&actions, fd) == 0, "applet file actions");
	pid_t child;
	int spawned = posix_spawn(&child, "/bin/busybox", &actions, NULL, argv, environ);
	posix_spawn_file_actions_destroy(&actions);
	require(spawned == 0, "spawn existing ipcs applet");
	int status;
	require(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 0,
	        "ipcs application exit");
	rewind(capture);
	size_t count = fread(bytes, 1, sizeof(bytes) - 1, capture);
	bytes[count] = 0;
	require(!ferror(capture) && strstr(bytes, needle) != NULL && fclose(capture) == 0,
	        "ipcs reports exact object ID");
}
#endif
struct packet { long type; unsigned char bytes[8]; };
static void messages(void)
{
	queue = msgget(IPC_PRIVATE, IPC_CREAT | 0600);
	require(queue >= 0, "message queue create");
	struct packet second = {2, {'B', 0, '2', 'x'}}, first = {1, {'A', 0, '1', 'y'}}, received = {0};
	require(msgsnd(queue, &second, 4, IPC_NOWAIT) == 0 && msgsnd(queue, &first, 4, IPC_NOWAIT) == 0,
	        "typed binary messages");
	struct msqid_ds state = {0};
	require(msgctl(queue, IPC_STAT, &state) == 0 && state.msg_qnum == 2 && state.msg_cbytes == 8 &&
	        state.msg_qbytes >= 8 && (state.msg_perm.mode & 0777) == 0600 && state.msg_stime > 0 &&
	        state.msg_ctime > 0 && state.msg_lspid == getpid(), "message metadata ABI");
#ifdef __wasm__
	applet_report("-q", queue, "msqid");
#endif
	require(msgrcv(queue, &received, 1, 0, IPC_NOWAIT) == -1 && errno == E2BIG &&
	        msgctl(queue, IPC_STAT, &state) == 0 && state.msg_qnum == 2, "short receive retains queue");
	require(msgrcv(queue, &received, sizeof(received.bytes), -2, IPC_NOWAIT) == 4 &&
	        received.type == 1 && !memcmp(received.bytes, first.bytes, 4), "lowest-type selection and bytes");
	require(msgrcv(queue, &received, 3, 0, IPC_NOWAIT | MSG_NOERROR) == 3 &&
	        received.type == 2 && !memcmp(received.bytes, second.bytes, 3), "truncating receive");
	require(msgrcv(queue, &received, sizeof(received.bytes), 0, IPC_NOWAIT) == -1 && errno == ENOMSG,
	        "empty queue");
	first.type = 0;
	require(msgsnd(queue, &first, 4, IPC_NOWAIT) == -1 && errno == EINVAL &&
	        msgctl(queue, IPC_STAT, &state) == 0 && state.msg_qnum == 0 && state.msg_cbytes == 0 &&
	        state.msg_lrpid == getpid(), "invalid type preserves queue");
	require(msgctl(queue, IPC_RMID, NULL) == 0, "queue removal");
	queue = -1;
	puts("sysv-ipc: typed binary queues, metadata, receive errors and removal pass");
}
struct waiter { int id, result, error; };
static void *wait_main(void *argument)
{
	struct waiter *waiter = argument;
	struct sembuf operation = {0, -1, 0};
	waiter->result = semop(waiter->id, &operation, 1);
	waiter->error = errno;
	return NULL;
}
static void semaphores_test(void)
{
	semaphores = semget(IPC_PRIVATE, 2, IPC_CREAT | 0600);
	require(semaphores >= 0, "semaphore set create");
	unsigned short values[] = {1, 0};
	require(semctl(semaphores, 0, SETALL, (union semun){.array = values}) == 0, "SETALL");
	struct sembuf atomic[] = {{0, -1, 0}, {1, -1, IPC_NOWAIT}};
	require(semop(semaphores, atomic, 2) == -1 && errno == EAGAIN &&
	        semctl(semaphores, 0, GETVAL) == 1 && semctl(semaphores, 1, GETVAL) == 0,
	        "failed multi-operation rollback");
	atomic[1].sem_op = 2;
	require(semop(semaphores, atomic, 2) == 0 &&
	        semctl(semaphores, 0, GETALL, (union semun){.array = values}) == 0 && values[0] == 0 && values[1] == 2,
	        "successful atomic operations");
	struct semid_ds state = {0};
	require(semctl(semaphores, 0, IPC_STAT, (union semun){.buf = &state}) == 0 && state.sem_nsems == 2 &&
	        (state.sem_perm.mode & 0777) == 0600 && state.sem_otime > 0 && state.sem_ctime > 0,
	        "semaphore metadata ABI");
#ifdef __wasm__
	applet_report("-s", semaphores, "semid");
#endif
	struct sembuf wait = {0, -1, 0};
	struct timespec timeout = {0, 1000000};
	require(semtimedop(semaphores, &wait, 1, &timeout) == -1 && errno == EAGAIN, "timed wait");
	timeout.tv_nsec = 1000000000;
	require(semtimedop(semaphores, &wait, 1, &timeout) == -1 && errno == EINVAL &&
	        semctl(semaphores, 0, GETVAL) == 0, "invalid timeout preserves value");
	puts("sysv-ipc: semaphore atomicity, metadata, timeout and error recovery pass");
	struct waiter waiter = {.id = semaphores};
	pthread_t thread;
	require(pthread_create(&thread, NULL, wait_main, &waiter) == 0, "blocking waiter thread");
	struct timespec start, now, pause = {0, 1000000};
	require(clock_gettime(CLOCK_MONOTONIC, &start) == 0, "readiness clock");
	int waiting;
	while ((waiting = semctl(semaphores, 0, GETNCNT)) != 1) {
		require(waiting >= 0, "query blocked waiter");
		require(clock_gettime(CLOCK_MONOTONIC, &now) == 0 && now.tv_sec - start.tv_sec < 10,
		        "kernel waiter readiness deadline");
		nanosleep(&pause, NULL);
	}
	require(semctl(semaphores, 0, IPC_RMID) == 0, "remove blocked set");
	semaphores = -1;
	require(pthread_join(thread, NULL) == 0 && waiter.result == -1 && waiter.error == EIDRM,
	        "removed waiter receives EIDRM");
	semaphores = semget(IPC_PRIVATE, 1, IPC_CREAT | 0600);
	require(semaphores >= 0 && semctl(semaphores, 0, SETVAL, (union semun){.val = 1}) == 0 &&
	        semctl(semaphores, 0, GETVAL) == 1 && semctl(semaphores, 0, IPC_RMID) == 0, "set recovery");
	semaphores = -1;
	puts("sysv-ipc: blocked removal, EIDRM and recovery pass");
}

#ifdef __wasm__
static void shared_memory_test(void)
{
	shared_memory = shmget(IPC_PRIVATE, 65536, IPC_CREAT | IPC_EXCL | 0600);
	require(shared_memory >= 0, "shared-memory create");

	struct shmid_ds original = {0};
	require(shmctl(shared_memory, IPC_STAT, &original) == 0 &&
		original.shm_segsz == 65536 && original.shm_perm.uid == geteuid() &&
		original.shm_perm.gid == getegid() && (original.shm_perm.mode & 0777) == 0600 &&
		original.shm_cpid == getpid() && original.shm_nattch == 0 && original.shm_ctime > 0,
		"shared-memory IPC_STAT metadata");
	applet_report("-m", shared_memory, "shmid");
	puts("sysv-ipc: shared-memory create, stat and applet identity pass");

	struct shmid_ds changed = original;
	changed.shm_perm.uid = geteuid();
	changed.shm_perm.gid = getegid();
	changed.shm_perm.mode = (changed.shm_perm.mode & ~0777) | 0640;
	require(shmctl(shared_memory, IPC_SET, &changed) == 0, "shared-memory IPC_SET");
	struct shmid_ds updated = {0};
	require(shmctl(shared_memory, IPC_STAT, &updated) == 0 &&
		updated.shm_segsz == original.shm_segsz && updated.shm_perm.uid == geteuid() &&
		updated.shm_perm.gid == getegid() && (updated.shm_perm.mode & 0777) == 0640 &&
		updated.shm_nattch == 0,
		"shared-memory metadata update");

	struct shminfo limits = {0};
	require(shmctl(0, IPC_INFO, (struct shmid_ds *)(void *)&limits) >= 0 &&
		limits.shmmax >= 65536 && limits.shmmni > 0,
		"shared-memory IPC_INFO");
	struct shm_info usage = {0};
	require(shmctl(0, SHM_INFO, (struct shmid_ds *)(void *)&usage) >= 0 && usage.used_ids > 0,
		"shared-memory SHM_INFO");
	puts("sysv-ipc: shared-memory IPC_SET, IPC_INFO and SHM_INFO pass");

	struct shmid_ds invalid = {0};
	errno = 0;
	require(raw_shmctl(shared_memory, IPC_STAT, (void *)(uintptr_t)UINTPTR_MAX) == -1 &&
		errno == EFAULT,
		"shared-memory valid-ID copyout fault");
	errno = 0;
	require(raw_shmctl(INT_MAX, IPC_STAT, &invalid) == -1 && errno == EINVAL,
		"shared-memory invalid-ID lookup precedes copyout");
	errno = 0;
	require(raw_shmctl(INT_MAX, IPC_SET, (void *)(uintptr_t)UINTPTR_MAX) == -1 &&
		errno == EFAULT,
		"shared-memory IPC_SET copyin precedes positive invalid-ID lookup");
	errno = 0;
	require(raw_shmctl(-1, IPC_STAT, &invalid) == -1 && errno == EINVAL,
		"shared-memory negative ID validation");
	puts("sysv-ipc: shared-memory bad-pointer and invalid-ID ordering pass");

	errno = 0;
	require(shmat(shared_memory, NULL, 0) == (void *)-1 && errno == ENOSYS,
		"shared-memory attachment remains unavailable");
	unsigned char byte = 0x71;
	errno = 0;
	require(shmdt(&byte) == -1 && errno == ENOSYS && byte == 0x71,
		"shared-memory detach remains unavailable");
	int removed_id = shared_memory;
	require(shmctl(shared_memory, IPC_RMID, NULL) == 0, "shared-memory IPC_RMID");
	shared_memory = -1;
	errno = 0;
	require(shmctl(removed_id, IPC_STAT, &invalid) == -1 && errno == EINVAL,
		"removed shared-memory ID is invalid");
	puts("sysv-ipc: shmat/shmdt ENOSYS boundary and shared-memory removal pass");
}
#endif
int main(void)
{
	atexit(cleanup);
#ifdef __wasm__
	if (mkdir("/proc", 0555)) require(errno == EEXIST, "proc directory");
	require(mount("proc", "/proc", "proc", 0, NULL) == 0, "mount proc");
#endif
	messages();
	semaphores_test();
#ifdef __wasm__
	shared_memory_test();
#endif
	puts("::vm-test::pass");
	fflush(stdout);
#ifdef __wasm__
	for (;;) sched_yield();
#endif
	return 0;
}
