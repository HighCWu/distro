{
  pkgs,
  lib,
  platform,
  llvm-toolchain,
  sysroot,
  vm-test,
}:

let
  cSource = pkgs.writeText "toolchain-smoke.c" ''
    #define _GNU_SOURCE

    #include <errno.h>
    #include <fcntl.h>
    #include <pthread.h>
    #include <sched.h>
    #include <signal.h>
    #include <stdint.h>
    #include <stdlib.h>
    #include <string.h>
    #include <sys/mman.h>
    #include <sys/statfs.h>
    #include <sys/statvfs.h>
    #include <unistd.h>

    static _Thread_local int tls_value = 41;
    static volatile sig_atomic_t signal_seen;

    static _Noreturn void report(const char *result, const char *detail) {
      write(STDOUT_FILENO, result, strlen(result));
      if (detail)
        write(STDOUT_FILENO, detail, strlen(detail));
      write(STDOUT_FILENO, "\n", 1);
      for (;;)
        sched_yield();
    }

    static _Noreturn void fail(const char *detail) {
      report("::vm-test::fail: ", detail);
    }

    static void *thread_main(void *argument) {
      if (tls_value != 41 || argument != (void *)(uintptr_t)0x12345678)
        return (void *)(uintptr_t)1;
      tls_value = 42;
      return NULL;
    }

    static void signal_handler(int signal_number) {
      if (signal_number == SIGUSR1)
        signal_seen = 1;
    }

    int main(int argc, char **argv) {
      if (argc != 1 || !argv[0] || strcmp(argv[0], "/init") != 0)
        fail("process arguments were not preserved");
      if (!getenv("HOME") || strcmp(getenv("HOME"), "/") != 0)
        fail("process environment was not preserved");

      /* On LP64 asm-generic statfs takes two arguments; the ILP32 statfs64
       * entry takes a structure size as well. A wrong syscall name can return
       * EFAULT and leave the caller's zeroed filesystem type looking valid. */
      struct statfs named_fs, opened_fs;
      struct statvfs named_vfs, opened_vfs;
      int root_fd = open("/", O_RDONLY | O_DIRECTORY);
      if (root_fd < 0 || statfs("/", &named_fs) || fstatfs(root_fd, &opened_fs))
        fail("statfs/fstatfs failed on the initramfs root");
      if ((named_fs.f_type != 0x858458f6UL && named_fs.f_type != 0x01021994UL) ||
          opened_fs.f_type != named_fs.f_type || !named_fs.f_bsize ||
          opened_fs.f_bsize != named_fs.f_bsize)
        fail("statfs/fstatfs returned invalid root type or block size");
      if (statvfs("/", &named_vfs) || fstatvfs(root_fd, &opened_vfs) ||
          named_vfs.f_bsize != named_fs.f_bsize ||
          opened_vfs.f_bsize != named_vfs.f_bsize ||
          named_vfs.f_namemax != named_fs.f_namelen ||
          opened_vfs.f_namemax != named_vfs.f_namemax)
        fail("statvfs/fstatvfs did not preserve filesystem metadata");
      if (close(root_fd))
        fail("closing root directory failed");

      uint64_t *value = malloc(sizeof(*value));
      if (!value)
        fail("malloc failed");
      *value = UINT64_C(0x123456789abcdef0);
      if (*value != UINT64_C(0x123456789abcdef0))
        fail("malloc memory was corrupted");
      free(value);

      const size_t page_size = 65536;
      size_t mapping_size = 5 * page_size;
      unsigned char *mapping = mmap(NULL, mapping_size, PROT_READ | PROT_WRITE,
                                    MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
      if (mapping == MAP_FAILED)
        fail("anonymous mmap failed");
      if ((uintptr_t)mapping % page_size != 0 || mapping[0] != 0 ||
          mapping[2 * page_size] != 0 || mapping[mapping_size - 1] != 0)
        fail("anonymous mmap was not aligned and zero-filled");
      for (size_t page = 0; page < 5; ++page)
        mapping[page * page_size] = (unsigned char)(page + 1);

      errno = 0;
      if (munmap(mapping + 1, page_size) != -1 || errno != EINVAL)
        fail("unaligned munmap did not fail with EINVAL");

      if (munmap(mapping + 2 * page_size, page_size) != 0)
        fail("middle munmap failed");
      if (mapping[0] != 1 || mapping[3 * page_size] != 4)
        fail("partial munmap released live mapping storage");
      if (munmap(mapping, page_size) != 0)
        fail("prefix munmap failed");
      if (munmap(mapping + 4 * page_size, page_size) != 0)
        fail("suffix munmap failed");
      if (mapping[page_size] != 2 || mapping[3 * page_size] != 4)
        fail("trimmed mapping storage was corrupted");
      if (munmap(mapping + page_size, page_size) != 0 ||
          munmap(mapping + 3 * page_size, page_size) != 0)
        fail("split mapping cleanup failed");
      if (munmap((void *)(uintptr_t)page_size, page_size) != 0)
        fail("unmapped range was not accepted as a no-op");

      errno = 0;
      mapping = mmap((void *)(uintptr_t)-mapping_size, mapping_size,
                     PROT_READ | PROT_WRITE,
                     MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED, -1, 0);
      if (mapping != MAP_FAILED || errno != ENOMEM)
        fail("out-of-range MAP_FIXED did not fail with ENOMEM");

      pthread_t thread;
      void *thread_result;
      tls_value = 40;
      if (pthread_create(&thread, NULL, thread_main,
                         (void *)(uintptr_t)0x12345678) != 0)
        fail("pthread_create failed");
      if (pthread_join(thread, &thread_result) != 0 || thread_result != NULL)
        fail("pthread callback failed");
      if (tls_value != 40)
        fail("thread-local storage was shared");

      if (signal(SIGUSR1, signal_handler) == SIG_ERR || raise(SIGUSR1) != 0)
        fail("signal setup failed");
      if (!signal_seen)
        fail("signal handler was not called");

      report("::vm-test::pass", NULL);
    }
  '';
  cxxSource = pkgs.writeText "toolchain-smoke.cc" ''
    #include <array>
    #include <cstdint>
    #include <memory>

    int main() {
      auto value = std::make_unique<std::array<std::uint64_t, 2>>();
      (*value)[1] = UINT64_C(0x123456789abcdef0);
      return (*value)[1] != UINT64_C(0x123456789abcdef0);
    }
  '';
  compileFlags = lib.escapeShellArgs (
    [
      "--target=${platform.targetTriple}"
      "--sysroot=${sysroot}"
    ]
    ++ platform.compilerFlags
    ++ map (flag: "-Wl,${flag}") platform.linkerFlags
  );
  programs =
    pkgs.runCommand "toolchain-smoke-${platform.wasmArch}"
      {
        passthru.checks = {
          cxx-runtime = vm-test.rawInitramfsTest {
            name = "toolchain-cxx-runtime-${platform.wasmArch}";
            init = "${programs}/runtime-cxx.wasm";
            cpus = 2;
          };
          c-runtime = vm-test.rawInitramfsTest {
            name = "toolchain-c-runtime-${platform.wasmArch}";
            init = "${programs}/smoke-c.wasm";
          };
          user-access = vm-test.rawInitramfsTest {
            name = "user-access-${platform.wasmArch}";
            init = "${programs}/user-access.wasm";
          };
          mremap = vm-test.rawInitramfsTest {
            name = "mremap-${platform.wasmArch}";
            init = "${programs}/mremap.wasm";
          };
          msync = vm-test.rawInitramfsTest {
            name = "msync-${platform.wasmArch}";
            init = "${programs}/msync.wasm";
          };
          madvise = vm-test.rawInitramfsTest {
            name = "madvise-${platform.wasmArch}";
            init = "${programs}/madvise.wasm";
          };
        }
        // lib.optionalAttrs (platform.addressBits == 32) {
          user-access-upper32 = vm-test.rawInitramfsTest {
            name = "user-access-upper-half-wasm32";
            init = "${programs}/user-access-upper32.wasm";
          };
        };
        nativeBuildInputs = [
          llvm-toolchain
          pkgs.wabt
        ];
      }
      ''
        mkdir -p $out
        clang ${compileFlags} ${cSource} -o $out/smoke-c.wasm
        clang ${compileFlags} -O2 -Wall -Wextra -Werror ${./user-access.c} -o $out/user-access.wasm
        clang ${compileFlags} -O2 -Wall -Wextra -Werror ${./mremap.c} -o $out/mremap.wasm
        chmod 0755 $out/mremap.wasm
        wasm-validate --enable-memory64 --enable-threads --enable-exceptions $out/mremap.wasm
        clang ${compileFlags} -O2 -Wall -Wextra -Werror ${./msync.c} -o $out/msync.wasm
        chmod 0755 $out/msync.wasm
        wasm-validate --enable-memory64 --enable-threads --enable-exceptions $out/msync.wasm
        clang ${compileFlags} -O2 -Wall -Wextra -Werror ${./madvise.c} -o $out/madvise.wasm
        chmod 0755 $out/madvise.wasm
        wasm-validate --enable-memory64 --enable-threads --enable-exceptions $out/madvise.wasm
        clang++ ${compileFlags} ${cxxSource} -o $out/smoke-cxx.wasm
        clang++ ${compileFlags} -std=c++17 -O2 -pthread -Wl,--fatal-warnings ${./runtime-cxx.cc} -o $out/runtime-cxx.wasm
        chmod 0755 $out/smoke-c.wasm $out/smoke-cxx.wasm
        chmod 0755 $out/runtime-cxx.wasm
        chmod 0755 $out/user-access.wasm
        wasm-validate --enable-memory64 --enable-threads --enable-exceptions $out/smoke-c.wasm
        wasm-validate --enable-memory64 --enable-threads --enable-exceptions $out/user-access.wasm
        wasm-validate --enable-memory64 --enable-threads --enable-exceptions $out/smoke-cxx.wasm
        wasm-validate --enable-memory64 --enable-threads --enable-exceptions $out/runtime-cxx.wasm
        ${lib.optionalString (platform.addressBits == 32) ''
          clang ${compileFlags} -O2 -Wall -Wextra -Werror -DUSER_ACCESS_UPPER32 ${./user-access.c} -o $out/user-access-upper32.wasm
          chmod 0755 $out/user-access-upper32.wasm
          wasm-validate --enable-memory64 --enable-threads --enable-exceptions $out/user-access-upper32.wasm
        ''}
      '';
in
programs
