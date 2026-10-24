// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/auxv.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/sysmacros.h>
#include <sys/wait.h>
#include <unistd.h>

static void require(int ok, const char *what)
{
    if (ok) return;
    printf("::vm-test::fail: exec-security: %s errno=%d\n", what, errno);
    fflush(stdout);
    _Exit(1);
}

int main(void)
{
    require(getuid() == 0 && geteuid() == 0 && getauxval(AT_SECURE) == 0, "initial root credentials");
    /* Secure libc startup may repair closed standard descriptors via /dev/null.
     * A raw initramfs has no obligation to contain the normal device nodes. */
    if (mknod("/dev/null", S_IFCHR | 0666, makedev(1, 3)))
        require(errno == EEXIST, "prepare null device");
    struct stat null_device;
    require(stat("/dev/null", &null_device) == 0 && S_ISCHR(null_device.st_mode) &&
            null_device.st_rdev == makedev(1, 3) && chmod("/dev/null", 0666) == 0,
            "null device usable for secure startup");
    require(chmod("/secure-helper", 04755) == 0 && chmod("/plain-helper", 0755) == 0,
            "prepare setuid and ordinary executable modes");
    int fd = open("/invalid-secure", O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0700);
    const char invalid[] = "\0not-Wasm";
    require(fd >= 0 && write(fd, invalid, sizeof invalid) == sizeof invalid &&
            close(fd) == 0 && chmod("/invalid-secure", 04755) == 0, "invalid setuid image");
    const char *modes[] = {"plain", "suid", "nnp", "recovery"};
    for (int mode = 0; mode < 4; ++mode) {
        pid_t child = fork();
        require(child >= 0, "fork before exec");
        if (!child) {
            if (mode && (setgroups(0, NULL) || setresgid(1000, 1000, 1000) ||
                         setresuid(1000, 1000, 1000))) _exit(91);
            if (mode == 2 && syscall(SYS_prctl, (long)PR_SET_NO_NEW_PRIVS, 1L, 0L, 0L, 0L, 0L)) _exit(92);
            char *args[] = {"exec-security-helper", (char *)modes[mode], NULL};
            char *env[] = {"EXEC_SECURITY_SENTINEL=present", NULL};
            if (mode == 3) {
                errno = 0;
                if (execve("/invalid-secure", args, env) != -1 || errno != ENOEXEC ||
                    getuid() != 1000 || geteuid() != 1000 || getauxval(AT_SECURE) != 0) _exit(93);
            }
            const char *path = mode == 1 || mode == 2 ? "/secure-helper" : "/plain-helper";
            execve(path, args, env);
            _exit(94);
        }
        int status = 0;
        pid_t waited;
        do waited = waitpid(child, &status, 0); while (waited < 0 && errno == EINTR);
        if (waited != child || !WIFEXITED(status) || WEXITSTATUS(status) != 37) {
            printf("exec-security: mode=%s waited=%ld status=%#x\n", modes[mode], (long)waited, status);
            require(0, "helper observes committed credentials and correct auxiliary vector");
        }
        require(getuid() == 0 && geteuid() == 0 && getauxval(AT_SECURE) == 0, "parent credentials unchanged");
        const char *stage[] = {
            "exec-security: ordinary exec credentials, auxv and secure_getenv pass",
            "exec-security: setuid transition publishes AT_SECURE and final uid metadata pass",
            "exec-security: no_new_privs prevents elevation and preserves ordinary environment access pass",
            "exec-security: rejected setuid image retains old credentials and later exec recovers pass",
        };
        puts(stage[mode]);
        fflush(stdout);
    }
    require(unlink("/invalid-secure") == 0, "invalid fixture cleanup");
    puts("::vm-test::pass");
    fflush(stdout);
#ifdef __wasm__
    for (;;) sched_yield();
#else
    return 0;
#endif
}
