// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <elf.h>
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <unistd.h>

static const char g_marker[] =
    "WASM_COREDUMP_MARKER_2026_11_27_LINEAR_MEM_CHECK_0123456789ABCDEF";
static volatile unsigned char g_marker_copy[128];

static int do_crash(void)
{
    struct rlimit rl = {
        .rlim_cur = RLIM_INFINITY,
        .rlim_max = RLIM_INFINITY,
    };
    if (setrlimit(RLIMIT_CORE, &rl) != 0) {
        perror("setrlimit(RLIMIT_CORE)");
        return 1;
    }
    for (size_t i = 0; i < sizeof(g_marker); ++i) {
        g_marker_copy[i] = (unsigned char)g_marker[i];
    }
    abort();
    return 1;
}

static int do_pipe_sink(const char *out_path)
{
    char tmp_path[512];
    if (snprintf(tmp_path, sizeof(tmp_path), "%s.tmp", out_path) >= (int)sizeof(tmp_path)) {
        fprintf(stderr, "pipe sink path too long\n");
        return 1;
    }
    int fd = open(tmp_path, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0644);
    if (fd < 0) {
        perror("open pipe sink tmp");
        return 1;
    }
    unsigned char buf[16384];
    for (;;) {
        ssize_t n = read(STDIN_FILENO, buf, sizeof(buf));
        if (n < 0) {
            if (errno == EINTR) continue;
            perror("read stdin");
            close(fd);
            return 1;
        }
        if (n == 0) break;
        size_t off = 0;
        while (off < (size_t)n) {
            ssize_t w = write(fd, buf + off, (size_t)n - off);
            if (w < 0) {
                if (errno == EINTR) continue;
                perror("write pipe sink");
                close(fd);
                return 1;
            }
            off += (size_t)w;
        }
    }
    if (close(fd) != 0) {
        perror("close pipe sink");
        return 1;
    }
    if (rename(tmp_path, out_path) != 0) {
        perror("rename pipe sink");
        return 1;
    }
    return 0;
}

static int has_marker(const unsigned char *data, size_t len)
{
    size_t needle_len = sizeof(g_marker) - 1;
    if (len < needle_len) return 0;
    for (size_t i = 0; i <= len - needle_len; ++i) {
        if (memcmp(data + i, g_marker, needle_len) == 0) return 1;
    }
    return 0;
}

static int do_verify(const char *core_path)
{
    int fd = open(core_path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) {
        perror("open core");
        return 1;
    }
    struct stat st;
    if (fstat(fd, &st) != 0 || st.st_size <= 0) {
        fprintf(stderr, "invalid core file size\n");
        close(fd);
        return 1;
    }
    size_t file_size = (size_t)st.st_size;
    unsigned char *buf = malloc(file_size);
    if (!buf) {
        fprintf(stderr, "oom reading core (%zu bytes)\n", file_size);
        close(fd);
        return 1;
    }
    size_t off = 0;
    while (off < file_size) {
        ssize_t n = read(fd, buf + off, file_size - off);
        if (n < 0) {
            if (errno == EINTR) continue;
            perror("read core");
            free(buf);
            close(fd);
            return 1;
        }
        if (n == 0) break;
        off += (size_t)n;
    }
    close(fd);
    if (off != file_size) {
        fprintf(stderr, "short core read\n");
        free(buf);
        return 1;
    }

    uint16_t e_type = 0, e_phnum = 0, e_phentsize = 0;
    uint64_t e_phoff = 0;
    int expected_class = (sizeof(void *) == 8) ? ELFCLASS64 : ELFCLASS32;
    if (file_size < (sizeof(void *) == 8 ? sizeof(Elf64_Ehdr) : sizeof(Elf32_Ehdr))) {
        fprintf(stderr, "core truncated before ehdr\n");
        free(buf);
        return 1;
    }
    if (memcmp(buf, ELFMAG, SELFMAG) != 0 || buf[EI_CLASS] != expected_class) {
        fprintf(stderr, "invalid ELF magic or class\n");
        free(buf);
        return 1;
    }

    int found_note = 0;
    int found_load = 0;
    int found_marker = 0;

    if (sizeof(void *) == 8) {
        const Elf64_Ehdr *eh = (const Elf64_Ehdr *)buf;
        e_type = eh->e_type;
        e_phoff = eh->e_phoff;
        e_phentsize = eh->e_phentsize;
        e_phnum = eh->e_phnum;
        if (e_type != ET_CORE || e_phnum < 2 || e_phentsize != sizeof(Elf64_Phdr) ||
            e_phoff + (uint64_t)e_phnum * e_phentsize > file_size) {
            fprintf(stderr, "invalid ELF64 core headers\n");
            free(buf);
            return 1;
        }
        const Elf64_Phdr *ph = (const Elf64_Phdr *)(buf + e_phoff);
        for (uint16_t i = 0; i < e_phnum; ++i) {
            if (ph[i].p_offset + ph[i].p_filesz > file_size) {
                fprintf(stderr, "phdr %u out of bounds\n", i);
                free(buf);
                return 1;
            }
            if (ph[i].p_type == PT_NOTE && ph[i].p_filesz >= sizeof(Elf64_Nhdr) + 8) {
                const Elf64_Nhdr *nh = (const Elf64_Nhdr *)(buf + ph[i].p_offset);
                const char *name = (const char *)(buf + ph[i].p_offset + sizeof(Elf64_Nhdr));
                if (nh->n_namesz == 5 && memcmp(name, "WASM", 4) == 0 &&
                    nh->n_type == NT_PRSTATUS) {
                    found_note = 1;
                }
            } else if (ph[i].p_type == PT_LOAD && ph[i].p_filesz > 0) {
                found_load++;
                if (has_marker(buf + ph[i].p_offset, (size_t)ph[i].p_filesz)) {
                    found_marker = 1;
                }
            }
        }
    } else {
        const Elf32_Ehdr *eh = (const Elf32_Ehdr *)buf;
        e_type = eh->e_type;
        e_phoff = eh->e_phoff;
        e_phentsize = eh->e_phentsize;
        e_phnum = eh->e_phnum;
        if (e_type != ET_CORE || e_phnum < 2 || e_phentsize != sizeof(Elf32_Phdr) ||
            e_phoff + (uint64_t)e_phnum * e_phentsize > file_size) {
            fprintf(stderr, "invalid ELF32 core headers\n");
            free(buf);
            return 1;
        }
        const Elf32_Phdr *ph = (const Elf32_Phdr *)(buf + e_phoff);
        for (uint16_t i = 0; i < e_phnum; ++i) {
            if (ph[i].p_offset + ph[i].p_filesz > file_size) {
                fprintf(stderr, "phdr %u out of bounds\n", i);
                free(buf);
                return 1;
            }
            if (ph[i].p_type == PT_NOTE && ph[i].p_filesz >= sizeof(Elf32_Nhdr) + 8) {
                const Elf32_Nhdr *nh = (const Elf32_Nhdr *)(buf + ph[i].p_offset);
                const char *name = (const char *)(buf + ph[i].p_offset + sizeof(Elf32_Nhdr));
                if (nh->n_namesz == 5 && memcmp(name, "WASM", 4) == 0 &&
                    nh->n_type == NT_PRSTATUS) {
                    found_note = 1;
                }
            } else if (ph[i].p_type == PT_LOAD && ph[i].p_filesz > 0) {
                found_load++;
                if (has_marker(buf + ph[i].p_offset, (size_t)ph[i].p_filesz)) {
                    found_marker = 1;
                }
            }
        }
    }

    free(buf);
    if (!found_note || found_load == 0 || !found_marker) {
        fprintf(stderr, "core verification failed note=%d load=%d marker=%d\n",
                found_note, found_load, found_marker);
        return 1;
    }
    printf("COREDUMP_VERIFY_OK phnum=%u loads=%d size=%zu\n",
           e_phnum, found_load, file_size);
    return 0;
}

int main(int argc, char **argv)
{
    if (argc == 2 && strcmp(argv[1], "--crash") == 0) {
        return do_crash();
    }
    if (argc == 3 && strcmp(argv[1], "--pipe-sink") == 0) {
        return do_pipe_sink(argv[2]);
    }
    if (argc == 3 && strcmp(argv[1], "--verify") == 0) {
        return do_verify(argv[2]);
    }
    fprintf(stderr, "usage: %s --crash | --pipe-sink <out> | --verify <core>\n", argv[0]);
    return 2;
}
