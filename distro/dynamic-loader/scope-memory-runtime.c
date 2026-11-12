// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/mount.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

#ifndef SYS_memfd_create
#error "The target Linux headers must provide SYS_memfd_create"
#endif

_Static_assert(sizeof(long) == sizeof(void *),
	       "memfd_create syscall words must match the target pointer width");

#define DEFAULT_MODULE_COUNT 256
#define TRANSIENT_FD_RESERVE 16
#define INITIAL_MAIN_VALUE UINT32_C(0x13579bdf)
#define MAIN_COOKIE_VALUE UINT32_C(0x2468ace0)

volatile uint32_t scope_memory_main_value = INITIAL_MAIN_VALUE;
volatile uint32_t scope_memory_main_cookie = MAIN_COOKIE_VALUE;

__attribute__((noinline, visibility("default"))) uint32_t
scope_memory_main_add(uint32_t delta)
{
	scope_memory_main_value += delta;
	return scope_memory_main_value;
}

struct LoadedModule {
	void *Handle;
	int Descriptor;
	uint32_t (*Apply)(uint32_t);
	uint32_t (*Calls)(void);
	dev_t Device;
	ino_t Inode;
};

static void fail(const char *Message)
{
	fprintf(stderr, "dynamic loader: %s (errno=%d)\n", Message, errno);
}

static int prepare_procfs(void)
{
#ifdef __wasm__
	if (getpid() == 1 && mount("proc", "/proc", "proc", 0, 0) != 0) {
		int SavedError = errno;
		fprintf(stderr,
			"::vm-test::fail: dynamic loader: mount proc failed (errno=%d)\n",
			SavedError);
		errno = SavedError;
		return -1;
	}
#endif
	return 0;
}

static int parse_count(const char *Text, size_t *Count)
{
	char *End = NULL;
	errno = 0;
	uintmax_t Value = strtoumax(Text, &End, 10);
	if (errno != 0 || End == Text || *End != '\0' || Value == 0 ||
	    Value > SIZE_MAX / sizeof(struct LoadedModule)) {
		return -1;
	}
	*Count = (size_t)Value;
	return 0;
}

static int prepare_descriptor_limit(size_t Count)
{
	struct rlimit Limit;
	if (getrlimit(RLIMIT_NOFILE, &Limit) != 0) {
		return -1;
	}
	if (Limit.rlim_cur == RLIM_INFINITY) {
		return 0;
	}
	if ((uintmax_t)Count > UINTMAX_MAX - TRANSIENT_FD_RESERVE) {
		errno = EOVERFLOW;
		return -1;
	}
	uintmax_t RequiredWide = (uintmax_t)Count + TRANSIENT_FD_RESERVE;
	rlim_t Required = RequiredWide > (uintmax_t)RLIM_INFINITY ?
				  RLIM_INFINITY :
				  (rlim_t)RequiredWide;
	if (Limit.rlim_cur >= Required) {
		return 0;
	}

	struct rlimit Updated = Limit;
	if (Limit.rlim_max != RLIM_INFINITY &&
	    Updated.rlim_cur > Limit.rlim_max) {
		Updated.rlim_cur = Limit.rlim_max;
	}
	if (Limit.rlim_max == RLIM_INFINITY ||
	    RequiredWide <= (uintmax_t)Limit.rlim_max) {
		Updated.rlim_cur = Required;
	} else {
		Updated.rlim_cur = Limit.rlim_max;
		fprintf(stderr,
			"dynamic loader: descriptor pressure budget is limited by hard RLIMIT_NOFILE=%ju for %zu modules; trying the available limit\n",
			(uintmax_t)Limit.rlim_max, Count);
	}
	if (Updated.rlim_cur > Limit.rlim_cur &&
	    setrlimit(RLIMIT_NOFILE, &Updated) != 0) {
		fprintf(stderr,
			"dynamic loader: could not raise soft RLIMIT_NOFILE toward %ju (errno=%d); continuing to test actual file operations\n",
			RequiredWide, errno);
	}
	return 0;
}

static int copy_file_contents(int Source, int Destination)
{
	char Buffer[8192];
	for (;;) {
		ssize_t Count = read(Source, Buffer, sizeof(Buffer));
		if (Count < 0 && errno == EINTR)
			continue;
		if (Count < 0)
			return -1;
		if (Count == 0)
			return 0;

		ssize_t Offset = 0;
		while (Offset < Count) {
			ssize_t Written = write(Destination, Buffer + Offset,
						(size_t)(Count - Offset));
			if (Written < 0 && errno == EINTR)
				continue;
			if (Written <= 0)
				return -1;
			Offset += Written;
		}
	}
}

static int create_module_file(int Source, size_t Index,
			      struct LoadedModule *Module,
			      const char **LoaderError)
{
	*LoaderError = NULL;
	char Name[64];
	int NameLength =
		snprintf(Name, sizeof(Name), "scope-memory-%zu", Index);
	if (NameLength < 0 || (size_t)NameLength >= sizeof(Name)) {
		errno = EOVERFLOW;
		return -1;
	}

	int Descriptor = (int)syscall(SYS_memfd_create, (long)(uintptr_t)Name,
				      (long)MFD_CLOEXEC);
	if (Descriptor < 0)
		return -1;

	int Result = -1;
	Module->Descriptor = Descriptor;
	struct stat Status;
	if (lseek(Source, 0, SEEK_SET) < 0 ||
	    copy_file_contents(Source, Descriptor) != 0 ||
	    fstat(Descriptor, &Status) != 0 || !S_ISREG(Status.st_mode)) {
		goto cleanup;
	}

	char Path[64];
	int PathLength =
		snprintf(Path, sizeof(Path), "/proc/self/fd/%d", Descriptor);
	if (PathLength < 0 || (size_t)PathLength >= sizeof(Path)) {
		errno = EOVERFLOW;
		goto cleanup;
	}

	dlerror();
	Module->Handle = dlopen(Path, RTLD_NOW | RTLD_LOCAL);
	if (Module->Handle == NULL) {
		*LoaderError = dlerror();
		goto cleanup;
	}

	dlerror();
	void *ApplySymbol = dlsym(Module->Handle, "scope_memory_library_apply");
	const char *ApplyError = dlerror();
	if (ApplyError != NULL || ApplySymbol == NULL) {
		*LoaderError = ApplyError ? ApplyError : "missing module entry";
		goto cleanup;
	}
	_Static_assert(sizeof(Module->Apply) == sizeof(ApplySymbol),
		       "function and data pointers must have equal size");
	memcpy(&Module->Apply, &ApplySymbol, sizeof(Module->Apply));

	dlerror();
	void *CallsSymbol = dlsym(Module->Handle, "scope_memory_library_calls");
	const char *CallsError = dlerror();
	if (CallsError != NULL || CallsSymbol == NULL) {
		*LoaderError = CallsError ? CallsError : "missing module state";
		goto cleanup;
	}
	_Static_assert(sizeof(Module->Calls) == sizeof(CallsSymbol),
		       "function and data pointers must have equal size");
	memcpy(&Module->Calls, &CallsSymbol, sizeof(Module->Calls));
	Module->Device = Status.st_dev;
	Module->Inode = Status.st_ino;
	Result = 0;

cleanup:
	return Result;
}

int main(int Argc, char **Argv)
{
	if (Argc > 3) {
		fprintf(stderr, "usage: %s [module-count [library-path]]\n",
			Argv[0]);
		return 2;
	}

	size_t Count = DEFAULT_MODULE_COUNT;
	if (Argc >= 2 && parse_count(Argv[1], &Count) != 0) {
		fprintf(stderr,
			"dynamic loader: module count must be a positive decimal integer\n");
		return 2;
	}
	const char *LibraryPath = Argc == 3 ? Argv[2] :
					      "./scope-memory-library.so";
	if (prepare_procfs() != 0) {
		return 1;
	}
	if (prepare_descriptor_limit(Count) != 0) {
		fail("read or raise the soft file descriptor limit");
		return 1;
	}

	struct LoadedModule *Modules = calloc(Count, sizeof(*Modules));
	if (Modules == NULL) {
		fail("allocate module records");
		return 1;
	}
	for (size_t Index = 0; Index < Count; ++Index) {
		Modules[Index].Descriptor = -1;
	}

	int Result = 1;
	int Source = open(LibraryPath, O_RDONLY | O_CLOEXEC);
	if (Source < 0) {
		if (errno == EMFILE || errno == ENFILE) {
			fprintf(stderr,
				"dynamic loader: descriptor pressure while opening the shared object (errno=%d)\n",
				errno);
		} else {
			fail("open shared object");
		}
		goto cleanup;
	}
	struct stat SourceStatus;
	if (fstat(Source, &SourceStatus) != 0 ||
	    !S_ISREG(SourceStatus.st_mode) || SourceStatus.st_size <= 0) {
		fail("shared object must be a nonempty regular file");
		goto cleanup;
	}

	for (size_t Index = 0; Index < Count; ++Index) {
		const char *LoaderError = NULL;
		if (create_module_file(Source, Index, &Modules[Index],
				       &LoaderError) != 0) {
			int SavedError = errno;
			if (SavedError == EMFILE || SavedError == ENFILE) {
				fprintf(stderr,
					"dynamic loader: descriptor pressure while loading module %zu (errno=%d)\n",
					Index, SavedError);
			} else if (LoaderError != NULL) {
				fprintf(stderr,
					"dynamic loader: loader error for module %zu: %s (errno=%d)\n",
					Index, LoaderError, SavedError);
			} else {
				errno = SavedError;
				fail("create module backing file");
			}
			errno = SavedError;
			goto cleanup;
		}
		if (scope_memory_main_value != INITIAL_MAIN_VALUE ||
		    scope_memory_main_cookie != MAIN_COOKIE_VALUE) {
			fprintf(stderr,
				"dynamic loader: main data changed while loading module %zu\n",
				Index);
			goto cleanup;
		}
		if (Modules[Index].Calls() != 0) {
			fprintf(stderr,
				"dynamic loader: module-local data was shared before call %zu\n",
				Index);
			goto cleanup;
		}
		for (size_t Previous = 0; Previous < Index; ++Previous) {
			int SameIdentity = Modules[Previous].Device ==
						   Modules[Index].Device &&
					   Modules[Previous].Inode ==
						   Modules[Index].Inode;
			int SameHandle = Modules[Previous].Handle ==
					 Modules[Index].Handle;
			int SameApply = Modules[Previous].Apply ==
					Modules[Index].Apply;
			int SameCalls = Modules[Previous].Calls ==
					Modules[Index].Calls;
			if (SameIdentity || SameHandle || SameApply ||
			    SameCalls) {
				fprintf(stderr,
					"dynamic loader: distinct module identity was reused at %zu (identity=%d handle=%d apply=%d calls=%d)\n",
					Index, SameIdentity, SameHandle,
					SameApply, SameCalls);
				goto cleanup;
			}
		}
	}
	for (size_t Index = 0; Index < Count; ++Index) {
		if (close(Modules[Index].Descriptor) != 0) {
			Modules[Index].Descriptor = -1;
			fail("close loaded module source");
			goto cleanup;
		}
		Modules[Index].Descriptor = -1;
	}

	for (size_t Index = 0; Index < Count; ++Index) {
		uint32_t Before = scope_memory_main_value;
		uint32_t Expected = Before + UINT32_C(1);
		uint32_t Actual = Modules[Index].Apply(UINT32_C(1));
		if (Actual != Expected || scope_memory_main_value != Expected ||
		    scope_memory_main_cookie != MAIN_COOKIE_VALUE ||
		    Modules[Index].Calls() != 1) {
			fprintf(stderr,
				"dynamic loader: module call or main data check failed at %zu\n",
				Index);
			goto cleanup;
		}
	}

	if (scope_memory_main_value != INITIAL_MAIN_VALUE + (uint32_t)Count ||
	    scope_memory_main_cookie != MAIN_COOKIE_VALUE) {
		fail("final main data check");
		goto cleanup;
	}
	Result = 0;

cleanup:
	if (Source >= 0 && close(Source) != 0 && Result == 0) {
		fail("close shared object");
		Result = 1;
	}
	for (size_t Index = Count; Index != 0; --Index) {
		if (Modules[Index - 1].Descriptor >= 0 &&
		    close(Modules[Index - 1].Descriptor) != 0) {
			fail("close module source during cleanup");
			Result = 1;
		}
		if (Modules[Index - 1].Handle != NULL &&
		    dlclose(Modules[Index - 1].Handle) != 0) {
			const char *Error = dlerror();
			fprintf(stderr,
				"dynamic loader: close module %zu: %s\n",
				Index - 1, Error ? Error : "unknown error");
			Result = 1;
		}
	}
	free(Modules);
	if (Result == 0) {
		puts("dynamic loader: repeated file identities and main data checks pass");
#ifdef __wasm__
		puts("::vm-test::pass");
#endif
	}
	return Result;
}
