// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <pthread.h>
#include <semaphore.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

static _Thread_local volatile int marker = 41;
static pthread_key_t key;
static sem_t finished;
static atomic_int callbacks, destructors, bad, mode;
static atomic_int helper_status = -999;
extern int __real_pthread_create(pthread_t *, const pthread_attr_t *, void *(*)(void *), void *);
int __wrap_pthread_create(pthread_t *thread, const pthread_attr_t *attr, void *(*start)(void *), void *arg)
{
    int status = __real_pthread_create(thread, attr, start, arg);
    atomic_store(&helper_status, status);
    return status;
}
static void require(int ok, const char *what)
{
    if (ok) return;
    printf("::vm-test::fail: thread timer: %s errno=%d\n", what, errno);
    exit(1);
}
static void destructor(void *ptr)
{
    if (ptr != (void *)&marker || marker != 99) atomic_store(&bad, 1);
    atomic_fetch_add(&destructors, 1);
    if (sem_post(&finished)) atomic_store(&bad, 1);
}
static void notify(union sigval value)
{
    if (value.sival_ptr != &finished || marker != 41) atomic_store(&bad, 1);
    marker = 99;
    if (pthread_setspecific(key, (void *)&marker)) atomic_store(&bad, 1);
    atomic_fetch_add(&callbacks, 1);
    if (atomic_load(&mode) == 1) pthread_exit(NULL);
}
static int tasks(void)
{
    DIR *directory = opendir("/proc/self/task");
    require(directory != NULL, "open task list");
    int count = 0;
    struct dirent *entry;
    errno = 0;
    while ((entry = readdir(directory))) if (entry->d_name[0] != '.') count++;
    require(errno == 0 && closedir(directory) == 0, "read and close task list");
    return count;
}
static void wait_workers(int baseline)
{
    struct timespec begin, now, delay = { .tv_nsec = 1000000 };
    require(clock_gettime(CLOCK_MONOTONIC, &begin) == 0, "cleanup deadline");
    for (;;) {
        if (tasks() == baseline) return;
        require(clock_gettime(CLOCK_MONOTONIC, &now) == 0 && now.tv_sec - begin.tv_sec < 5,
                "detached timer worker must disappear");
        require(nanosleep(&delay, NULL) == 0, "yield for detached cleanup");
    }
}
static timer_t create(struct sigevent *event)
{
    timer_t timer;
    require(timer_create(CLOCK_MONOTONIC, event, &timer) == 0, "create thread timer");
    return timer;
}
static void fire(timer_t timer, int current_mode, int expected)
{
    atomic_store(&mode, current_mode);
    struct itimerspec arm = { .it_value = { .tv_nsec = 1000000 } };
    require(timer_settime(timer, 0, &arm, NULL) == 0, "arm one-shot callback");
    struct timespec until;
    require(clock_gettime(CLOCK_REALTIME, &until) == 0, "callback deadline");
    until.tv_sec += 5;
    int result;
    do { result = sem_timedwait(&finished, &until); } while (result && errno == EINTR);
    require(result == 0 && atomic_load(&callbacks) == expected &&
            atomic_load(&destructors) == expected && !atomic_load(&bad),
            "callback completion, TSD destructor and fresh native TLS");
    require(marker == 41, "parent native TLS remains private");
}
int main(void)
{
    setvbuf(stdout, NULL, _IONBF, 0);
    require(mkdir("/proc", 0555) == 0 || errno == EEXIST, "proc mountpoint");
    require(mount("proc", "/proc", "proc", 0, NULL) == 0, "mount proc fixture");
    int baseline = tasks();
    require(baseline == 1 && sem_init(&finished, 0, 0) == 0 &&
            pthread_key_create(&key, destructor) == 0, "initial timer/thread state");
    struct sigevent event = { .sigev_notify = SIGEV_THREAD,
        .sigev_notify_function = notify, .sigev_value.sival_ptr = &finished };
    timer_t timer;
    errno = 0;
    int created = timer_create((clockid_t)0x40000000, &event, &timer);
    int creation_errno = errno;
    if (created != -1 || creation_errno != EINVAL)
        fprintf(stderr, "thread timer: rejected clock diagnostics result=%d errno=%d helper_status=%d\n",
                created, creation_errno, atomic_load(&helper_status));
    require(created == -1 && creation_errno == EINVAL,
            "invalid kernel clock rolls back helper creation");
    wait_workers(baseline);
    puts("thread timer: rejected clock rolls back helper thread and kernel timer pass");
    timer = create(&event);
    fire(timer, 0, 1);
    fire(timer, 1, 2);
    fire(timer, 0, 3);
    puts("thread timer: callback return and pthread_exit recover with fresh native TLS and TSD pass");
    require(timer_delete(timer) == 0, "delete reused callback timer");
    wait_workers(baseline);
    timer = create(&event);
    fire(timer, 0, 4);
    require(timer_delete(timer) == 0, "delete later timer");
    wait_workers(baseline);
    require(pthread_key_delete(key) == 0 && sem_destroy(&finished) == 0 &&
            umount("/proc") == 0, "release standard fixtures");
    puts("thread timer: deletion reaps detached workers and later creation recovers pass");
    puts("::vm-test::pass");
    for (;;) pause();
}
