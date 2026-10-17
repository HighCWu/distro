/* SPDX-License-Identifier: MIT */
/* Native workload checks only: no target kernel, ABI, budgets or mount proof.
 * Pad the source to three 64-KiB chunks: a native 4-KiB kernel otherwise faults
 * on whole pages beyond EOF instead of providing the target's copied tail. */
#define _GNU_SOURCE
static char host_source[] = "/tmp/linux-wasm-file-lifetime-XXXXXX";
#define FILE_MMAP_SOURCE host_source
#define main target_main
#include "mmap-file-lifetime.c"
#undef main

int main(void)
{
	const size_t page = 65536;
	int fd = mkstemp(host_source);
	if (fd < 0) return 1;
	unsigned char *data = calloc(3, page);
	if (!data) return 2;
	for (size_t i = 0; i < 2 * page + 7; i++) data[i] = (unsigned char)(i * 37 + 11);
	ssize_t written = write(fd, data, 3 * page);
	free(data);
	if (written != (ssize_t)(3 * page) || lseek(fd, 23, SEEK_SET) != 23) return 3;
	unsigned char *ro = mapped(fd, page, PROT_READ);
	unsigned char *rw = mapped(fd, page, PROT_READ | PROT_WRITE);
	private_lifetime(fd, page, ro, rw);
	concurrent_copies(fd, page);
	if (lseek(fd, 0, SEEK_CUR) != 23) return 4;
	if (close(fd) || unlink(host_source)) return 5;
	/* Native unlink is NOT the target EROFS unmount test. */
	detached_lifetime(ro, rw, page);
	puts("native workload only: standard lifetime helpers passed; no Wasm or unmount evidence");
	return 0;
}
