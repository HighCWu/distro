/* SPDX-License-Identifier: MIT */
/* Native workload only: native mmap is NOT the target's eager copy. */
#define main target_main
#include "mmap-file-benchmark.c"
#undef main

int main(void)
{
	char source[] = "/tmp/linux-wasm-file-benchmark-XXXXXX";
	int fd = mkstemp(source);
	if (fd < 0 || unlink(source)) return 1;
	unsigned char *data = malloc(131079);
	if (!data) return 2;
	for (size_t i = 0; i < 131079; i++) data[i] = (unsigned char)(i * 37 + 11);
	ssize_t count = write(fd, data, 131079);
	free(data);
	if (count != 131079 || lseek(fd, 23, SEEK_SET) != 23) return 3;
	benchmark(fd);
	if (close(fd)) return 4;
	puts("host-workload-only: no Wasm performance conclusion");
	return 0;
}
