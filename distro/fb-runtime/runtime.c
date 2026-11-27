// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/fb.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>

#define EXPECTED_WIDTH  640U
#define EXPECTED_HEIGHT 480U
#define EXPECTED_BPP    32U
#define EXPECTED_STRIDE (EXPECTED_WIDTH * (EXPECTED_BPP / 8U))
#define EXPECTED_SIZE   (EXPECTED_STRIDE * EXPECTED_HEIGHT)

static int write_all_at(int fd, const void *buf, size_t len, off_t offset)
{
    const uint8_t *p = buf;
    size_t done = 0;

    while (done < len) {
        ssize_t w = pwrite(fd, p + done, len - done, offset + (off_t)done);
        if (w < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        if (w == 0) {
            errno = EIO;
            return -1;
        }
        done += (size_t)w;
    }
    return 0;
}

static int read_all_at(int fd, void *buf, size_t len, off_t offset)
{
    uint8_t *p = buf;
    size_t done = 0;

    while (done < len) {
        ssize_t r = pread(fd, p + done, len - done, offset + (off_t)done);
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

int main(void)
{
    int fd = -1;
    for (int i = 0; i < 50; ++i) {
        fd = open("/dev/fb0", O_RDWR | O_CLOEXEC);
        if (fd >= 0) break;
        usleep(100000);
    }
    if (fd < 0) {
        perror("open(/dev/fb0)");
        return 1;
    }

    struct fb_fix_screeninfo finfo;
    memset(&finfo, 0, sizeof(finfo));
    if (ioctl(fd, FBIOGET_FSCREENINFO, &finfo) != 0) {
        perror("ioctl(FBIOGET_FSCREENINFO)");
        close(fd);
        return 1;
    }
    if (finfo.smem_len < EXPECTED_SIZE || finfo.line_length != EXPECTED_STRIDE ||
        finfo.visual != FB_VISUAL_TRUECOLOR) {
        fprintf(stderr, "unexpected fb fix info: smem_len=%u line_length=%u visual=%u\n",
                finfo.smem_len, finfo.line_length, finfo.visual);
        close(fd);
        return 1;
    }

    struct fb_var_screeninfo vinfo;
    memset(&vinfo, 0, sizeof(vinfo));
    if (ioctl(fd, FBIOGET_VSCREENINFO, &vinfo) != 0) {
        perror("ioctl(FBIOGET_VSCREENINFO)");
        close(fd);
        return 1;
    }
    if (vinfo.xres != EXPECTED_WIDTH || vinfo.yres != EXPECTED_HEIGHT ||
        vinfo.bits_per_pixel != EXPECTED_BPP) {
        fprintf(stderr, "unexpected fb var info: %ux%ux%u\n",
                vinfo.xres, vinfo.yres, vinfo.bits_per_pixel);
        close(fd);
        return 1;
    }

    uint8_t row[EXPECTED_STRIDE];
    for (uint32_t x = 0; x < EXPECTED_WIDTH; ++x) {
        size_t off = (size_t)x * 4U;
        row[off + 0] = (uint8_t)(x & 0xffU);
        row[off + 1] = (uint8_t)((x >> 1) & 0xffU);
        row[off + 2] = 0xa5U;
        row[off + 3] = 0xffU;
    }

    if (write_all_at(fd, row, sizeof(row), 0) != 0) {
        perror("pwrite(/dev/fb0, row 0)");
        close(fd);
        return 1;
    }

    uint8_t tail_pixel[4] = { 0xdeU, 0xadU, 0xbeU, 0xefU };
    off_t tail_off = (off_t)(EXPECTED_SIZE - sizeof(tail_pixel));
    if (lseek(fd, tail_off, SEEK_SET) != tail_off ||
        write(fd, tail_pixel, sizeof(tail_pixel)) != (ssize_t)sizeof(tail_pixel)) {
        perror("write(/dev/fb0, last pixel)");
        close(fd);
        return 1;
    }

    if (ioctl(fd, FBIOPAN_DISPLAY, &vinfo) != 0) {
        perror("ioctl(FBIOPAN_DISPLAY)");
        close(fd);
        return 1;
    }

    uint8_t verify_row[EXPECTED_STRIDE];
    uint8_t verify_tail[4];
    if (read_all_at(fd, verify_row, sizeof(verify_row), 0) != 0 ||
        memcmp(verify_row, row, sizeof(row)) != 0) {
        fprintf(stderr, "fb0 row 0 readback mismatch\n");
        close(fd);
        return 1;
    }
    if (read_all_at(fd, verify_tail, sizeof(verify_tail), tail_off) != 0 ||
        memcmp(verify_tail, tail_pixel, sizeof(tail_pixel)) != 0) {
        fprintf(stderr, "fb0 tail pixel readback mismatch\n");
        close(fd);
        return 1;
    }

    close(fd);
    printf("::vm-test::fb:verify:%u:%u:%u\n",
           vinfo.xres, vinfo.yres, vinfo.bits_per_pixel);
    fflush(stdout);
    printf("fb-runtime ok (%s %ux%ux%u)\n",
           finfo.id, vinfo.xres, vinfo.yres, vinfo.bits_per_pixel);
    return 0;
}
