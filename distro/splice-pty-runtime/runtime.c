// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/sendfile.h>
#include <termios.h>
#include <unistd.h>

static volatile sig_atomic_t got_winch;

static void on_winch(int signo)
{
    if (signo == SIGWINCH)
        got_winch = 1;
}

static void on_unexpected_signal(int signo)
{
    const char msg[] = "splice-pty: unexpected SIGHUP\n";
    ssize_t r = write(STDERR_FILENO, msg, sizeof(msg) - 1);
    (void)r;
    _exit(128 + signo);
}

static int write_full(int fd, const void *buf, size_t len)
{
    const uint8_t *p = buf;
    size_t done = 0;

    while (done < len) {
        ssize_t w = write(fd, p + done, len - done);
        if (w < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        done += (size_t)w;
    }
    return 0;
}

static int read_full(int fd, void *buf, size_t len)
{
    uint8_t *p = buf;
    size_t done = 0;

    while (done < len) {
        ssize_t r = read(fd, p + done, len - done);
        if (r < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        if (r == 0) {
            errno = EIO;
            return -1;
        }
        done += (size_t)r;
    }
    return 0;
}

static int splice_all(int fd_in, loff_t *off_in, int fd_out, loff_t *off_out, size_t len)
{
    size_t done = 0;

    while (done < len) {
        ssize_t n = splice(fd_in, off_in, fd_out, off_out, len - done, 0);
        if (n < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        if (n == 0) {
            errno = EIO;
            return -1;
        }
        done += (size_t)n;
    }
    return 0;
}

static int tee_all(int fd_in, int fd_out, size_t len)
{
    size_t done = 0;

    while (done < len) {
        ssize_t n = tee(fd_in, fd_out, len - done, 0);
        if (n < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        if (n == 0) {
            errno = EIO;
            return -1;
        }
        done += (size_t)n;
    }
    return 0;
}

static int test_zero_copy(void)
{
    const char src_path[] = "/tmp/splice_pty_src.bin";
    const char dst_cfr_path[] = "/tmp/splice_pty_cfr.bin";
    const char dst_sf_path[] = "/tmp/splice_pty_sf.bin";
    uint8_t payload[8192];
    uint8_t check[8192];

    for (size_t i = 0; i < sizeof(payload); ++i)
        payload[i] = (uint8_t)((i * 37U + 13U) & 0xffU);

    int src_fd = open(src_path, O_RDWR | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
    if (src_fd < 0) {
        perror("open src");
        return 1;
    }
    if (write_full(src_fd, payload, sizeof(payload)) != 0) {
        perror("write src");
        close(src_fd);
        return 1;
    }

    int p1[2] = { -1, -1 };
    int p2[2] = { -1, -1 };
    if (pipe2(p1, O_CLOEXEC) != 0 || pipe2(p2, O_CLOEXEC) != 0) {
        perror("pipe2");
        close(src_fd);
        return 1;
    }

    loff_t off_in = 0;
    puts("splice-pty: step splice1");
    if (splice_all(src_fd, &off_in, p1[1], NULL, sizeof(payload)) != 0 ||
        off_in != (loff_t)sizeof(payload)) {
        perror("splice(file -> pipe)");
        goto fail_pipes;
    }

    puts("splice-pty: step tee");
    if (tee_all(p1[0], p2[1], sizeof(payload)) != 0) {
        perror("tee(pipe -> pipe)");
        goto fail_pipes;
    }

    /* Verify tee duplicated into p2 without consuming p1. */
    memset(check, 0, sizeof(check));
    puts("splice-pty: step read_tee");
    if (read_full(p2[0], check, sizeof(check)) != 0 ||
        memcmp(check, payload, sizeof(payload)) != 0) {
        fprintf(stderr, "tee destination payload mismatch\n");
        goto fail_pipes;
    }

    /* Splice p1 back into a fresh file and verify original pipe data was intact. */
    int cfr_fd = open(dst_cfr_path, O_RDWR | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
    if (cfr_fd < 0) {
        perror("open cfr_fd");
        goto fail_pipes;
    }
    loff_t off_out = 0;
    puts("splice-pty: step splice2");
    if (splice_all(p1[0], NULL, cfr_fd, &off_out, sizeof(payload)) != 0 ||
        off_out != (loff_t)sizeof(payload)) {
        perror("splice(pipe -> file)");
        close(cfr_fd);
        goto fail_pipes;
    }

    int sf_fd = open(dst_sf_path, O_RDWR | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
    if (sf_fd < 0) {
        perror("open sf_fd");
        close(cfr_fd);
        goto fail_pipes;
    }

    /* copy_file_range(cfr_fd -> sf_fd) */
    off_t cfr_in = 0;
    off_t cfr_out = 0;
    size_t cfr_left = sizeof(payload);
    puts("splice-pty: step copy_file_range");
    while (cfr_left > 0) {
        ssize_t n = copy_file_range(cfr_fd, &cfr_in, sf_fd, &cfr_out, cfr_left, 0);
        if (n <= 0) {
            perror("copy_file_range");
            close(sf_fd);
            close(cfr_fd);
            goto fail_pipes;
        }
        cfr_left -= (size_t)n;
    }

    memset(check, 0, sizeof(check));
    if (pread(sf_fd, check, sizeof(check), 0) != (ssize_t)sizeof(check) ||
        memcmp(check, payload, sizeof(payload)) != 0) {
        fprintf(stderr, "copy_file_range payload mismatch\n");
        close(sf_fd);
        close(cfr_fd);
        goto fail_pipes;
    }

    /* sendfile(src_fd -> p2[1]) */
    off_t sf_off = 0;
    size_t sf_left = sizeof(payload);
    puts("splice-pty: step sendfile");
    while (sf_left > 0) {
        ssize_t n = sendfile(p2[1], src_fd, &sf_off, sf_left);
        if (n <= 0) {
            perror("sendfile");
            close(sf_fd);
            close(cfr_fd);
            goto fail_pipes;
        }
        sf_left -= (size_t)n;
    }
    memset(check, 0, sizeof(check));
    puts("splice-pty: step read_sendfile");
    if (read_full(p2[0], check, sizeof(check)) != 0 ||
        memcmp(check, payload, sizeof(payload)) != 0) {
        fprintf(stderr, "sendfile payload mismatch\n");
        close(sf_fd);
        close(cfr_fd);
        goto fail_pipes;
    }

    close(sf_fd);
    close(cfr_fd);
    close(p1[0]);
    close(p1[1]);
    close(p2[0]);
    close(p2[1]);
    close(src_fd);
    unlink(src_path);
    unlink(dst_cfr_path);
    unlink(dst_sf_path);
    return 0;

fail_pipes:
    close(p1[0]);
    close(p1[1]);
    close(p2[0]);
    close(p2[1]);
    close(src_fd);
    return 1;
}

static int test_pty_winch(void)
{
    if (setsid() < 0 && errno != EPERM) {
        perror("setsid");
        return 1;
    }

    int master_fd = posix_openpt(O_RDWR | O_NOCTTY | O_CLOEXEC);
    if (master_fd < 0) {
        perror("posix_openpt");
        return 1;
    }
    if (grantpt(master_fd) != 0 || unlockpt(master_fd) != 0) {
        perror("grantpt/unlockpt");
        close(master_fd);
        return 1;
    }

    const char *slave_name = ptsname(master_fd);
    if (!slave_name) {
        perror("ptsname");
        close(master_fd);
        return 1;
    }

    int slave_fd = open(slave_name, O_RDWR | O_NOCTTY | O_CLOEXEC);
    if (slave_fd < 0) {
        perror("open(ptsname)");
        close(master_fd);
        return 1;
    }

    if (ioctl(slave_fd, TIOCSCTTY, 0) != 0) {
        perror("ioctl(TIOCSCTTY)");
        close(slave_fd);
        close(master_fd);
        return 1;
    }

    struct sigaction sa;
    memset(&sa, 0, sizeof(sa));
    sa.sa_handler = on_winch;
    sigemptyset(&sa.sa_mask);
    if (sigaction(SIGWINCH, &sa, NULL) != 0) {
        perror("sigaction(SIGWINCH)");
        close(slave_fd);
        close(master_fd);
        return 1;
    }

    got_winch = 0;
    struct winsize ws = {
        .ws_row = 40,
        .ws_col = 120,
        .ws_xpixel = 0,
        .ws_ypixel = 0,
    };
    if (ioctl(master_fd, TIOCSWINSZ, &ws) != 0) {
        perror("ioctl(TIOCSWINSZ)");
        close(slave_fd);
        close(master_fd);
        return 1;
    }

    for (int i = 0; i < 50 && !got_winch; ++i)
        usleep(10000);
    if (!got_winch) {
        fprintf(stderr, "SIGWINCH was not delivered after TIOCSWINSZ\n");
        close(slave_fd);
        close(master_fd);
        return 1;
    }

    struct winsize got = { 0 };
    if (ioctl(slave_fd, TIOCGWINSZ, &got) != 0 ||
        got.ws_row != 40 || got.ws_col != 120) {
        fprintf(stderr, "TIOCGWINSZ mismatch: got %ux%u expected 40x120\n",
                got.ws_row, got.ws_col);
        close(slave_fd);
        close(master_fd);
        return 1;
    }

    close(slave_fd);
    close(master_fd);
    return 0;
}

int main(void)
{
    setvbuf(stdout, NULL, _IONBF, 0);
    setvbuf(stderr, NULL, _IONBF, 0);
    struct sigaction hup_sa;
    memset(&hup_sa, 0, sizeof(hup_sa));
    hup_sa.sa_handler = on_unexpected_signal;
    sigemptyset(&hup_sa.sa_mask);
    sigaction(SIGHUP, &hup_sa, NULL);
    puts("splice-pty: start zero-copy");
    if (test_zero_copy() != 0)
        return 1;
    puts("splice-pty: start pty-winch");
    if (test_pty_winch() != 0)
        return 1;
    puts("splice-pty-runtime ok");
    return 0;
}
