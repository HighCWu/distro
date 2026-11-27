// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/input.h>
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>

static int test_bit(const unsigned char *bits, unsigned int bit)
{
    return (bits[bit / 8] >> (bit % 8)) & 1;
}

static int read_event_pair(int fd, uint16_t expected_code, int32_t expected_value)
{
    int got_key = 0;
    int got_syn = 0;

    while (!got_syn) {
        struct pollfd pfd = {
            .fd = fd,
            .events = POLLIN,
        };
        int rc = poll(&pfd, 1, 5000);
        if (rc <= 0) {
            fprintf(stderr, "poll(/dev/input/event0) failed: rc=%d errno=%d\n", rc, errno);
            return 1;
        }
        struct input_event ev[8];
        ssize_t n = read(fd, ev, sizeof(ev));
        if (n < 0) {
            if (errno == EINTR) continue;
            perror("read(/dev/input/event0)");
            return 1;
        }
        size_t count = (size_t)n / sizeof(ev[0]);
        for (size_t i = 0; i < count; ++i) {
            if (ev[i].type == EV_KEY && ev[i].code == expected_code &&
                ev[i].value == expected_value) {
                got_key = 1;
            } else if (ev[i].type == EV_SYN && ev[i].code == SYN_REPORT) {
                if (got_key) {
                    got_syn = 1;
                    break;
                }
            }
        }
    }
    return 0;
}

int main(void)
{
    int fd = -1;
    for (int i = 0; i < 50; ++i) {
        fd = open("/dev/input/event0", O_RDONLY | O_CLOEXEC);
        if (fd >= 0) break;
        usleep(100000);
    }
    if (fd < 0) {
        perror("open(/dev/input/event0)");
        return 1;
    }

    char name[128] = {0};
    if (ioctl(fd, EVIOCGNAME(sizeof(name)), name) < 0 || name[0] == '\0') {
        perror("ioctl(EVIOCGNAME)");
        close(fd);
        return 1;
    }

    unsigned char ev_bits[8] = {0};
    if (ioctl(fd, EVIOCGBIT(0, sizeof(ev_bits)), ev_bits) < 0 ||
        !test_bit(ev_bits, EV_SYN) || !test_bit(ev_bits, EV_KEY)) {
        fprintf(stderr, "missing EV_SYN or EV_KEY capability on %s\n", name);
        close(fd);
        return 1;
    }

    unsigned char key_bits[(KEY_MAX + 7) / 8] = {0};
    if (ioctl(fd, EVIOCGBIT(EV_KEY, sizeof(key_bits)), key_bits) < 0 ||
        !test_bit(key_bits, KEY_A)) {
        fprintf(stderr, "missing KEY_A capability on %s\n", name);
        close(fd);
        return 1;
    }

    printf("evdev name=%s\n", name);
    printf("::vm-test::input:%u:%d\n", KEY_A, 1);
    fflush(stdout);
    if (read_event_pair(fd, KEY_A, 1) != 0) {
        close(fd);
        return 1;
    }

    printf("::vm-test::input:%u:%d\n", KEY_A, 0);
    fflush(stdout);
    if (read_event_pair(fd, KEY_A, 0) != 0) {
        close(fd);
        return 1;
    }

    close(fd);
    printf("input-runtime ok\n");
    return 0;
}
