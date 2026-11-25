// SPDX-License-Identifier: MIT
#define _GNU_SOURCE

#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <sched.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/wait.h>
#include <unistd.h>

#define CHILD_STACK_SIZE (1024 * 1024)
#ifndef PRIMARY_LIBRARY
#define PRIMARY_LIBRARY "/plugins/libprocess-copy-library.so"
#endif
#ifndef AFTER_LIBRARY
#define AFTER_LIBRARY "/plugins/libprocess-copy-after.so"
#endif

typedef int (*get_value_fn)(void);
typedef void (*set_value_fn)(int);
typedef unsigned (*constructor_count_fn)(void);
typedef int (*call_fn)(void);
typedef int (*after_value_fn)(void);
typedef unsigned (*after_constructor_count_fn)(void);

static int process_copy_main_global = 13;
static _Thread_local int process_copy_main_tls = 31;

struct PristineChildArguments {
  int expected_global;
  int expected_tls;
  int changed_global;
  int changed_tls;
};

struct DSOChildArguments {
  void *primary_handle;
  get_value_fn get_value;
  set_value_fn set_value;
  constructor_count_fn constructor_count;
  call_fn call;
  int expected_global;
  int expected_value;
  int expected_tls;
  int changed_global;
  int new_value;
  int new_tls;
};

struct PrivateVforkArguments {
  struct DSOChildArguments dso;
  int *heap_value;
  int pipe_read;
  int pipe_write;
};

static _Noreturn void fail(const char *stage, int error)
{
#ifdef __wasm__
  fprintf(stdout, "::vm-test::fail: process-copy: %s errno=%d (%s)\n", stage, error,
          error ? strerror(error) : "none");
  fflush(stdout);
#else
  fprintf(stderr, "process-copy failure: %s errno=%d (%s)\n", stage, error,
          error ? strerror(error) : "none");
  fflush(stderr);
#endif
  _exit(1);
}

static _Noreturn void fail_dl(const char *stage, const char *message)
{
#ifdef __wasm__
  fprintf(stdout, "::vm-test::fail: process-copy: %s: %s\n", stage,
          message ? message : "dlerror returned no diagnostic");
  fflush(stdout);
#else
  fprintf(stderr, "process-copy failure: %s: %s\n", stage,
          message ? message : "dlerror returned no diagnostic");
  fflush(stderr);
#endif
  _exit(1);
}

static void *open_library(const char *path, const char *stage)
{
  (void)dlerror();
  void *handle = dlopen(path, RTLD_NOW | RTLD_LOCAL);
  if (!handle) fail_dl(stage, dlerror());
  return handle;
}

static void *lookup_symbol(void *handle, const char *name, const char *stage)
{
  (void)dlerror();
  void *symbol = dlsym(handle, name);
  const char *message = dlerror();
  if (message || !symbol) fail_dl(stage, message);
  return symbol;
}

static void mount_proc_if_needed(void)
{
#ifdef __wasm__
  if (mount("proc", "/proc", "proc", 0, NULL) != 0 && errno != EBUSY)
    fail("mount procfs", errno);
#endif
}

static int wait_for_child(pid_t child, const char *stage)
{
  int status = 0;
  pid_t result;
  do {
    result = waitpid(child, &status, 0);
  } while (result < 0 && errno == EINTR);
  if (result < 0) fail(stage, errno);
  if (result != child || !WIFEXITED(status) || WEXITSTATUS(status) != 0)
    fail(stage, ECHILD);
  return status;
}

static int pristine_child_run(void *opaque)
{
  struct PristineChildArguments *args = opaque;
  if (process_copy_main_global != args->expected_global ||
      process_copy_main_tls != args->expected_tls)
    fail("pristine child inherited main data", EPROTO);
  process_copy_main_global = args->changed_global;
  process_copy_main_tls = args->changed_tls;
  if (process_copy_main_global != args->changed_global ||
      process_copy_main_tls != args->changed_tls)
    fail("pristine child private main-data mutation", EPROTO);
  return 0;
}

struct NestedChildArguments {
  get_value_fn get_value;
  set_value_fn set_value;
  constructor_count_fn constructor_count;
  call_fn call;
  after_value_fn after_value;
  after_constructor_count_fn after_constructor_count;
  int expected_global;
  int expected_value;
  int expected_tls;
  int changed_global;
  int changed_value;
  int changed_tls;
};

static pid_t start_child(int (*entry)(void *), void *args, void **stack_out);

static int nested_child_run(void *opaque)
{
  struct NestedChildArguments *args = opaque;
  if (args->constructor_count() != 1 || args->get_value() != args->expected_value ||
      args->call() != args->expected_value * 2 || args->after_value() != 73 ||
      args->after_constructor_count() != 1 ||
      process_copy_main_global != args->expected_global ||
      process_copy_main_tls != args->expected_tls)
    fail("nested child inherited both DSOs and main data", EPROTO);

  args->set_value(args->changed_value);
  process_copy_main_global = args->changed_global;
  process_copy_main_tls = args->changed_tls;
  if (args->constructor_count() != 1 || args->get_value() != args->changed_value ||
      args->after_value() != 73 || process_copy_main_global != args->changed_global ||
      process_copy_main_tls != args->changed_tls)
    fail("nested child private DSO/main-data mutation", EPROTO);
  return 0;
}

static int dso_child_run(void *opaque)
{
  struct DSOChildArguments *args = opaque;
  if (args->constructor_count() != 1 || args->get_value() != args->expected_value ||
      process_copy_main_global != args->expected_global ||
      process_copy_main_tls != args->expected_tls)
    fail("child inherited primary DSO and main data", EPROTO);

  args->set_value(args->new_value);
  process_copy_main_global = args->changed_global;
  process_copy_main_tls = args->new_tls;
  if (args->get_value() != args->new_value || args->call() != args->new_value * 2 ||
      process_copy_main_global != args->changed_global ||
      process_copy_main_tls != args->new_tls)
    fail("child private DSO/main-data mutation", EPROTO);

  void *after_handle = open_library(AFTER_LIBRARY, "dlopen child-only library");
  after_value_fn after_value = (after_value_fn)lookup_symbol(
      after_handle, "process_copy_after_value", "dlsym child-only library");
  after_constructor_count_fn after_constructor_count =
      (after_constructor_count_fn)lookup_symbol(
          after_handle, "process_copy_after_constructor_count",
          "dlsym child-only constructor count");
  if (after_value() != 73 || after_constructor_count() != 1)
    fail("call child-only library", EPROTO);

  struct NestedChildArguments nested = {
      .get_value = args->get_value,
      .set_value = args->set_value,
      .constructor_count = args->constructor_count,
      .call = args->call,
      .after_value = after_value,
      .after_constructor_count = after_constructor_count,
      .expected_global = args->changed_global,
      .expected_value = args->new_value,
      .expected_tls = args->new_tls,
      .changed_global = 79,
      .changed_value = 83,
      .changed_tls = 89,
  };
  void *nested_stack = NULL;
  pid_t nested_child = start_child(nested_child_run, &nested, &nested_stack);
  (void)wait_for_child(nested_child, "wait for nested child");
  free(nested_stack);

  if (args->constructor_count() != 1 || args->get_value() != args->new_value ||
      args->call() != args->new_value * 2 || after_value() != 73 ||
      after_constructor_count() != 1 ||
      process_copy_main_global != args->changed_global ||
      process_copy_main_tls != args->new_tls)
    fail("child retained its state after nested child", EPROTO);

  if (dlclose(after_handle) != 0) fail_dl("dlclose child-only library", dlerror());

  // The parent's reference count and mappings are in the parent's copied loader
  // state. Closing this inherited reference must not invalidate the parent.
  if (dlclose(args->primary_handle) != 0)
    fail_dl("dlclose inherited primary library", dlerror());
  return 0;
}

static int second_child_run(void *opaque)
{
  struct DSOChildArguments *args = opaque;
  if (args->constructor_count() != 1 || args->get_value() != args->expected_value ||
      process_copy_main_global != args->expected_global ||
      process_copy_main_tls != args->expected_tls)
    fail("second child inherited primary DSO and main data", EPROTO);
  args->set_value(args->new_value);
  process_copy_main_global = args->changed_global;
  process_copy_main_tls = args->new_tls;
  if (args->call() != args->new_value * 2 ||
      process_copy_main_global != args->changed_global ||
      process_copy_main_tls != args->new_tls)
    fail("second child private mutation", EPROTO);
  return 0;
}

static int private_vfork_child_run(void *opaque)
{
  struct PrivateVforkArguments *args = opaque;
  if (close(args->pipe_read) != 0) fail("private vfork child close reader", errno);
  if (*args->heap_value != 107) fail("private vfork inherited heap", EPROTO);
  (void)second_child_run(&args->dso);
  *args->heap_value = 109;
  if (*args->heap_value != 109) fail("private vfork child heap mutation", EPROTO);

  // Last callback actions: the parent must observe both the marker and EOF
  // immediately after clone returns, without a blocking read or a wait first.
  const char marker = 'V';
  if (write(args->pipe_write, &marker, 1) != 1)
    fail("private vfork child final marker", errno);
  if (close(args->pipe_write) != 0) fail("private vfork child close writer", errno);
  return 0;
}

static pid_t start_child_with_flags(int (*entry)(void *), void *args,
                                   int flags, void **stack_out)
{
  void *stack = malloc(CHILD_STACK_SIZE);
  if (!stack) fail("allocate child stack", errno ? errno : ENOMEM);
  uintptr_t stack_top = ((uintptr_t)stack + CHILD_STACK_SIZE) & ~(uintptr_t)15;
  pid_t child = clone(entry, (void *)stack_top, flags, args);
  if (child < 0) {
    int error = errno;
    free(stack);
    fail("clone child", error);
  }
  *stack_out = stack;
  return child;
}

static pid_t start_child(int (*entry)(void *), void *args, void **stack_out)
{
  return start_child_with_flags(entry, args, SIGCHLD, stack_out);
}

int main(void)
{
  setvbuf(stdout, NULL, _IONBF, 0);
  setvbuf(stderr, NULL, _IONBF, 0);
  mount_proc_if_needed();

  struct PristineChildArguments pristine = {
      .expected_global = 13,
      .expected_tls = 31,
      .changed_global = 17,
      .changed_tls = 19,
  };
  void *pristine_stack = NULL;
  pid_t pristine_child = start_child(pristine_child_run, &pristine, &pristine_stack);
  (void)wait_for_child(pristine_child, "wait for pristine child");
  free(pristine_stack);
  if (process_copy_main_global != 13 || process_copy_main_tls != 31)
    fail("parent retained pristine main data", EPROTO);
  puts("PROCESS_COPY_PRISTINE_CHILD_OK");

  void *primary_handle = open_library(PRIMARY_LIBRARY, "dlopen primary library");
  get_value_fn get_value = (get_value_fn)lookup_symbol(
      primary_handle, "process_copy_get_value", "dlsym process_copy_get_value");
  set_value_fn set_value = (set_value_fn)lookup_symbol(
      primary_handle, "process_copy_set_value", "dlsym process_copy_set_value");
  constructor_count_fn constructor_count = (constructor_count_fn)lookup_symbol(
      primary_handle, "process_copy_constructor_count", "dlsym process_copy_constructor_count");
  call_fn call = (call_fn)lookup_symbol(
      primary_handle, "process_copy_call", "dlsym process_copy_call");

  if (constructor_count() != 1 || get_value() != 23 || process_copy_main_tls != 31)
    fail("primary DSO constructor and initial state", EPROTO);
  set_value(41);
  process_copy_main_global = 29;
  process_copy_main_tls = 47;
  if (get_value() != 41 || call() != 82 || process_copy_main_global != 29 ||
      process_copy_main_tls != 47)
    fail("prepare parent DSO/TLS state", EPROTO);

  struct DSOChildArguments first = {
      .primary_handle = primary_handle,
      .get_value = get_value,
      .set_value = set_value,
      .constructor_count = constructor_count,
      .call = call,
      .expected_global = 29,
      .expected_value = 41,
      .expected_tls = 47,
      .changed_global = 71,
      .new_value = 59,
      .new_tls = 61,
  };
  void *first_stack = NULL;
  pid_t first_child = start_child(dso_child_run, &first, &first_stack);
  (void)wait_for_child(first_child, "wait for first child");
  free(first_stack);

  if (constructor_count() != 1 || get_value() != 41 || call() != 82 ||
      process_copy_main_global != 29 || process_copy_main_tls != 47)
    fail("parent retained DSO/main data after nested child", EPROTO);
  puts("PROCESS_COPY_DSO_NESTED_CHILD_OK");

  struct DSOChildArguments second = first;
  second.expected_value = 41;
  second.expected_global = 29;
  second.expected_tls = 47;
  second.changed_global = 97;
  second.new_value = 67;
  second.new_tls = 71;
  void *second_stack = NULL;
  pid_t second_child = start_child(second_child_run, &second, &second_stack);
  (void)wait_for_child(second_child, "wait for second child");
  free(second_stack);

  if (constructor_count() != 1 || get_value() != 41 || call() != 82 ||
      process_copy_main_global != 29 || process_copy_main_tls != 47)
    fail("parent retained DSO/main data after second child", EPROTO);
  puts("PROCESS_COPY_SECOND_CHILD_OK");

  int pipe_fds[2];
  if (pipe2(pipe_fds, O_NONBLOCK | O_CLOEXEC) != 0)
    fail("private vfork create completion pipe", errno);
  int *heap_value = malloc(sizeof(*heap_value));
  if (!heap_value) fail("private vfork allocate heap", ENOMEM);
  *heap_value = 107;
  struct PrivateVforkArguments synchronous = {
      .dso = second,
      .heap_value = heap_value,
      .pipe_read = pipe_fds[0],
      .pipe_write = pipe_fds[1],
  };
  void *synchronous_stack = NULL;
  pid_t synchronous_child = start_child_with_flags(
      private_vfork_child_run, &synchronous, SIGCHLD | CLONE_VFORK,
      &synchronous_stack);
  if (close(pipe_fds[1]) != 0) fail("private vfork parent close writer", errno);
  char marker = 0;
  if (read(pipe_fds[0], &marker, 1) != 1 || marker != 'V')
    fail("private vfork parent resumed before final child marker", EPROTO);
  if (read(pipe_fds[0], &marker, 1) != 0)
    fail("private vfork parent resumed before child writer closed", EPROTO);
  if (*heap_value != 107 || constructor_count() != 1 || get_value() != 41 ||
      call() != 82 || process_copy_main_global != 29 || process_copy_main_tls != 47)
    fail("private vfork parent retained heap and DSO state", EPROTO);
  (void)wait_for_child(synchronous_child, "wait for private vfork child");
  if (close(pipe_fds[0]) != 0) fail("private vfork parent close reader", errno);
  free(synchronous_stack);
  free(heap_value);
  puts("PROCESS_COPY_PRIVATE_VFORK_CHILD_OK");

  if (dlclose(primary_handle) != 0) fail_dl("dlclose parent primary library", dlerror());
  puts("PROCESS_COPY_PARENT_CLOSE_OK");
#ifdef __wasm__
  puts("::vm-test::pass");
  fflush(stdout);
  for (;;) (void)sched_yield();
#endif
  return 0;
}
