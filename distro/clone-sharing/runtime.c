// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/sched.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/sem.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

#ifndef ROOT
#define ROOT "/clone-sharing"
#endif
static volatile int private_value = 61;
static int cleanup_semid = -1;
static void cleanup_semaphore(void)
{
    if (cleanup_semid >= 0) (void)semctl(cleanup_semid, 0, IPC_RMID);
}

static void require(int ok, const char *what)
{
    if (!ok) {
        fprintf(stderr, "::vm-test::fail: clone sharing: %s errno=%d\n", what, errno);
        exit(1);
    }
}

static pid_t create(int legacy, unsigned long flags)
{
    if (legacy) return syscall(SYS_clone, (long)(flags | SIGCHLD), 0L, 0L, 0L, 0L, 0L);
    struct clone_args args = { .flags = flags, .exit_signal = SIGCHLD };
    return syscall(SYS_clone3, (long)(uintptr_t)&args, (long)sizeof args);
}

static void reap(pid_t child, int expected)
{
    int status;
    pid_t result;
    do { result = waitpid(child, &status, 0); } while (result < 0 && errno == EINTR);
    require(result == child && WIFEXITED(status) && WEXITSTATUS(status) == expected, "exact child exit");
    errno = 0;
    require(waitpid(child, &status, WNOHANG) == -1 && errno == ECHILD, "single reap");
    require(private_value == 61, "separate user memory preserved");
}

static void cwd_is(const char *expected)
{
    char cwd[256];
    require(getcwd(cwd, sizeof cwd) && !strcmp(cwd, expected), "observable Linux cwd");
}

static void share_fs(int legacy)
{
    mode_t original = umask(022);
    pid_t child = create(legacy, CLONE_FS);
    require(child >= 0, "clone with shared fs_struct");
    if (!child) {
        private_value = 99;
        require(chdir(ROOT "/sub") == 0, "child changes shared cwd");
        require(umask(077) == 022, "child sees parent umask");
        _exit(37);
    }
    reap(child, 37);
    cwd_is(ROOT "/sub");
    require(umask(022) == 077, "parent observes child umask");
    umask(original);
    require(chdir("/") == 0, "restore cwd");
}

static void share_files(int legacy, int detach)
{
    int fd = open(ROOT "/data", O_RDONLY | O_CLOEXEC);
    require(fd >= 0, "open parent file");
    pid_t child = create(legacy, CLONE_FILES);
    require(child >= 0, "clone with shared files_struct");
    if (!child) {
        private_value = 99;
        if (detach)
            require(syscall(SYS_close_range, (long)fd, (long)fd, 2L) == 0,
                    "close_range UNSHARE detaches child file table");
        else require(close(fd) == 0, "child closes shared descriptor");
        _exit(38);
    }
    reap(child, 38);
    if (detach) {
        char bytes[5];
        require(pread(fd, bytes, sizeof bytes, 0) == sizeof bytes && !memcmp(bytes, "alpha", 5),
                "parent descriptor survives child UNSHARE");
        require(close(fd) == 0, "close surviving parent descriptor");
    } else {
        errno = 0;
        require(fcntl(fd, F_GETFD) == -1 && errno == EBADF, "shared close visible in parent");
    }
}

static void sem_adjust(int id)
{
    struct sembuf operation = { .sem_num = 0, .sem_op = -1, .sem_flg = SEM_UNDO };
    require(semop(id, &operation, 1) == 0, "record kernel semaphore undo adjustment");
}

static void share_semundo(int legacy, int shared)
{
    int id = semget(IPC_PRIVATE, 1, IPC_CREAT | 0600);
    require(id >= 0, "private semaphore set");
    cleanup_semid = id;
    union { int val; struct semid_ds *buf; unsigned short *array; } argument = { .val = 5 };
    require(semctl(id, 0, SETVAL, argument) == 0, "initial semaphore value");
    pid_t owner = fork();
    require(owner >= 0, "isolated undo owner");
    if (!owner) {
        sem_adjust(id);
        require(semctl(id, 0, GETVAL) == 4, "owner adjustment visible");
        pid_t child = create(legacy, shared ? CLONE_SYSVSEM : 0);
        require(child >= 0, "clone with selected semaphore undo ownership");
        if (!child) {
            private_value = 99;
            sem_adjust(id);
            _exit(37);
        }
        reap(child, 37);
        require(semctl(id, 0, GETVAL) == (shared ? 3 : 4),
                "shared undo survives child exit; private undo applies immediately");
        _exit(40);
    }
    reap(owner, 40);
    require(semctl(id, 0, GETVAL) == 5, "last owner exit restores all kernel undo adjustments");
    require(semctl(id, 0, IPC_RMID) == 0, "remove semaphore set");
    cleanup_semid = -1;
}

int main(void)
{
    require(setvbuf(stdout, NULL, _IONBF, 0) == 0, "unbuffered stages");
    require(atexit(cleanup_semaphore) == 0, "semaphore failure cleanup");
    cwd_is("/");
    require(mkdir(ROOT, 0755) == 0 && mkdir(ROOT "/sub", 0755) == 0, "filesystem fixtures");
    int fd = open(ROOT "/data", O_RDWR | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
    require(fd >= 0 && write(fd, "alpha", 5) == 5 && close(fd) == 0, "write exact fixture");
    for (int legacy =
#ifdef __wasm__
         0
#else
         1 /* Native reference uses clone; host sandbox may deny clone3. */
#endif
         ; legacy < 2; legacy++) {
        share_fs(legacy);
        share_files(legacy, 0);
        share_files(legacy, 1);
        errno = 0;
        pid_t rejected = create(legacy, CLONE_FS | CLONE_NEWNS);
        if (!rejected) _exit(90);
        require(rejected == -1 && errno == EINVAL, "Linux rejects FS/NEWNS conflict");
        cwd_is("/");
        puts(legacy ? "clone sharing: legacy clone cwd/umask, shared close and UNSHARE pass"
                    : "clone sharing: native clone3 cwd/umask, shared close and UNSHARE pass");
        share_semundo(legacy, 0);
        share_semundo(legacy, 1);
#ifdef __wasm__
        /* The native reference's host sandbox can reject NEWIPC before Linux
         * reaches its flag-conflict check. Require the exact kernel result
         * in the isolated target instead. */
        errno = 0;
        rejected = create(legacy, CLONE_SYSVSEM | CLONE_NEWIPC);
        if (!rejected) _exit(90);
        require(rejected == -1 && errno == EINVAL, "Linux rejects SYSVSEM/NEWIPC conflict");
#endif
        puts(legacy ? "clone sharing: legacy clone SEM_UNDO ownership and last-exit recovery pass"
                    : "clone sharing: native clone3 SEM_UNDO ownership and last-exit recovery pass");
    }
    fd = open(ROOT "/data", O_RDONLY | O_CLOEXEC);
    require(fd >= 0, "ordinary fork parent descriptor");
    pid_t child = fork();
    require(child >= 0, "ordinary fork recovery");
    if (!child) {
        private_value = 99;
        require(chdir(ROOT "/sub") == 0 && close(fd) == 0, "ordinary child modifies its own resources");
        _exit(39);
    }
    reap(child, 39);
    cwd_is("/");
    require(fcntl(fd, F_GETFD) >= 0 && close(fd) == 0, "ordinary child close stays isolated");
    require(unlink(ROOT "/data") == 0 && rmdir(ROOT "/sub") == 0 && rmdir(ROOT) == 0,
            "filesystem cleanup");
    puts("clone sharing: ordinary fork isolation, error recovery and cleanup pass");
    puts("::vm-test::pass");
#ifdef __wasm__
    for (;;) pause();
#else
    return 0;
#endif
}
