// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#define MODULE_COUNT 1025

static dev_t devices[MODULE_COUNT];
static ino_t inodes[MODULE_COUNT];

static int copy_file(int Source, int Destination)
{
	char Buffer[4096];
	for (;;) {
		ssize_t Count = read(Source, Buffer, sizeof(Buffer));
		if (Count < 0 && errno == EINTR) continue;
		if (Count < 0) return -1;
		if (Count == 0) return 0;

		ssize_t Offset = 0;
		while (Offset < Count) {
			ssize_t Written = write(Destination, Buffer + Offset, (size_t)(Count - Offset));
			if (Written < 0 && errno == EINTR) continue;
			if (Written <= 0) return -1;
			Offset += Written;
		}
	}
}

int main(int argc, char **argv)
{
	if (argc > 2) {
		fprintf(stderr, "usage: %s [capacity-leaf.so]\n", argv[0]);
		return 2;
	}
	const char *LeafPath = argc == 2 ? argv[1] : "./capacity-leaf.so";
	if (mkdir("/tmp", 0777) != 0 && errno != EEXIST) {
		perror("create temporary directory");
		return 1;
	}

	char Directory[] = "/tmp/dylink-capacity-XXXXXX";
	if (!mkdtemp(Directory)) {
		perror("mkdtemp");
		return 1;
	}
	int Result = 1;
	int Source = -1;
	int Destination = -1;
	size_t Created = 0;
	char Path[PATH_MAX];

	Source = open(LeafPath, O_RDONLY | O_CLOEXEC);
	if (Source < 0) {
		perror("open capacity leaf");
		goto cleanup;
	}

	struct stat SourceStatus;
	if (fstat(Source, &SourceStatus) != 0) {
		perror("stat capacity leaf");
		goto cleanup;
	}
	if (!S_ISREG(SourceStatus.st_mode) || SourceStatus.st_size <= 0) {
		fprintf(stderr, "capacity leaf is not a nonempty regular file\n");
		goto cleanup;
	}

	for (size_t Index = 0; Index < MODULE_COUNT; ++Index) {
		int Length = snprintf(Path, sizeof(Path), "%s/module-%04zu.so", Directory, Index);
		if (Length < 0 || (size_t)Length >= sizeof(Path)) {
			fprintf(stderr, "capacity path overflow at %zu\n", Index);
			goto cleanup;
		}

		Destination = open(Path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0700);
		if (Destination < 0) {
			perror("create capacity module");
			goto cleanup;
		}
		Created = Index + 1;

		if (lseek(Source, 0, SEEK_SET) < 0 || copy_file(Source, Destination) != 0) {
			perror("copy capacity module");
			goto cleanup;
		}

		struct stat Status;
		if (fstat(Destination, &Status) != 0) {
			perror("stat copied capacity module");
			goto cleanup;
		}
		for (size_t Previous = 0; Previous < Index; ++Previous) {
			if (devices[Previous] == Status.st_dev && inodes[Previous] == Status.st_ino) {
				fprintf(stderr, "duplicate inode at module %zu\n", Index);
				goto cleanup;
			}
		}
		devices[Index] = Status.st_dev;
		inodes[Index] = Status.st_ino;

		if (close(Destination) != 0) {
			Destination = -1;
			perror("close copied capacity module");
			goto cleanup;
		}
		Destination = -1;

		dlerror();
		void *Handle = dlopen(Path, RTLD_NOW | RTLD_LOCAL);
		if (!Handle) {
			const char *Error = dlerror();
			fprintf(stderr, "dlopen module %zu: %s\n", Index, Error ? Error : "unknown error");
			goto cleanup;
		}

		dlerror();
		void *Symbol = dlsym(Handle, "capacity_leaf_value");
		const char *SymbolError = dlerror();
		if (SymbolError || !Symbol) {
			fprintf(stderr, "dlsym module %zu: %s\n", Index,
			        SymbolError ? SymbolError : "missing symbol");
			(void)dlclose(Handle);
			goto cleanup;
		}

		int (*Value)(void);
		_Static_assert(sizeof(Value) == sizeof(Symbol), "function and data pointers have matching size");
		memcpy(&Value, &Symbol, sizeof(Value));
		if (Value() != 0x13579bdf) {
			fprintf(stderr, "wrong module value at %zu\n", Index);
			(void)dlclose(Handle);
			goto cleanup;
		}
		if (dlclose(Handle) != 0) {
			const char *Error = dlerror();
			fprintf(stderr, "dlclose module %zu: %s\n", Index, Error ? Error : "unknown error");
			goto cleanup;
		}
	}

	if (Created != MODULE_COUNT) {
		fprintf(stderr, "loaded %zu modules, expected %u\n", Created, MODULE_COUNT);
		goto cleanup;
	}
	puts("dynamic loader: 1025 unique dlopen and dlclose cycles pass");
	Result = 0;

cleanup:
	if (Destination >= 0) (void)close(Destination);
	if (Source >= 0) (void)close(Source);
	for (size_t Index = 0; Index < Created; ++Index) {
		if (snprintf(Path, sizeof(Path), "%s/module-%04zu.so", Directory, Index) >= (int)sizeof(Path))
			continue;
		(void)unlink(Path);
	}
	(void)rmdir(Directory);
#ifdef __wasm__
	if (Result == 0) puts("::vm-test::pass");
#endif
	return Result;
}
