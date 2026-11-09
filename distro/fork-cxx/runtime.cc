// SPDX-License-Identifier: MIT
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <stdexcept>
#include <string>
#include <sys/wait.h>
#include <unistd.h>
#include <vector>

namespace {

int global_state = 11;
thread_local int tls_state = 17;
thread_local std::string tls_label(64, 't');

[[noreturn]] void fail(const char *message)
{
  throw std::runtime_error(message);
}

void require(bool condition, const char *message)
{
  if (!condition)
    fail(message);
}

void wait_for_success(pid_t child)
{
  int status = 0;
  pid_t result;
  do {
    result = waitpid(child, &status, 0);
  } while (result == -1 && errno == EINTR);
  require(result == child, "waitpid failed");
  require(WIFEXITED(status) && WEXITSTATUS(status) == 0,
          "fork child reported a failed check");
}

struct DestructorCounter {
  int *count;
  ~DestructorCounter() { ++*count; }
};

struct HeapState {
  std::string text = "before";
  std::vector<int> values{1, 2};
};

bool tls_label_is(char expected)
{
  if (tls_label.size() != 64 || tls_label[0] != expected)
    return false;
  for (std::size_t index = 1; index < tls_label.size(); ++index) {
    if (tls_label[index] != 't')
      return false;
  }
  return true;
}

bool original_state(const HeapState &heap)
{
  return heap.text == "before" && heap.values.size() == 2 &&
         heap.values[0] == 1 && heap.values[1] == 2 && global_state == 11 &&
         tls_state == 17 && tls_label_is('s');
}

int fork_with_raii(HeapState &heap, int &destructor_count)
{
  DestructorCounter counter{&destructor_count};
  pid_t child = fork();
  if (child == -1)
    fail("ordinary fork failed");

  if (child == 0) {
    require(original_state(heap), "child did not inherit the initial C++ state");
    heap.text += "-child";
    heap.values.push_back(3);
    global_state = 31;
    tls_state = 37;
    tls_label[0] = 'c';
    return 1;
  }

  require(original_state(heap), "parent state changed at fork return");
  heap.text += "-parent";
  heap.values.push_back(4);
  global_state = 41;
  tls_state = 43;
  tls_label[0] = 'p';
  wait_for_success(child);
  return 0;
}

void stage_heap_tls_raii()
{
  HeapState heap;
  require(tls_label_is('t'), "C++ TLS label did not initialize before fork");
  tls_label[0] = 's';
  require(tls_label_is('s'), "C++ TLS label setup before fork failed");
  int destructor_count = 0;
  const int branch = fork_with_raii(heap, destructor_count);
  require(destructor_count == 1, "stack RAII object did not unwind exactly once");

  if (branch == 1) {
    require(heap.text == "before-child" && heap.values.size() == 3 &&
                heap.values[2] == 3 && global_state == 31 && tls_state == 37 &&
                tls_label_is('c'),
            "child C++ state was not private and mutable");
    _exit(0);
  }

  require(heap.text == "before-parent" && heap.values.size() == 3 &&
              heap.values[2] == 4 && global_state == 41 && tls_state == 43 &&
              tls_label_is('p'),
          "parent C++ state changed with the child");
}

void check_exception_unwind()
{
  int destructor_count = 0;
  bool runtime_error_caught = false;
  try {
    DestructorCounter counter{&destructor_count};
    throw std::runtime_error("forked runtime error");
  } catch (const std::runtime_error &error) {
    runtime_error_caught = std::strcmp(error.what(), "forked runtime error") == 0;
  }
  require(runtime_error_caught && destructor_count == 1,
          "std::runtime_error did not unwind through its local destructor");

  bool integer_caught = false;
  try {
    DestructorCounter counter{&destructor_count};
    throw 73;
  } catch (int value) {
    integer_caught = value == 73;
  }
  require(integer_caught && destructor_count == 2,
          "integer exception did not unwind through its local destructor");
}

void stage_parent_child_exceptions()
{
  pid_t child = fork();
  if (child == -1)
    fail("fork before exception checks failed");
  if (child == 0) {
    check_exception_unwind();
    _exit(0);
  }

  check_exception_unwind();
  wait_for_success(child);
}

#if defined(__wasm__)
void require_no_waitable_children()
{
  int status = 0;
  errno = 0;
  pid_t result = waitpid(-1, &status, WNOHANG);
  int saved_errno = errno;
  require(result == -1 && saved_errno == ECHILD,
          "unexpected child exists after refused fork");
}
#endif

void stage_active_exception()
{
  static constexpr const char *message = "active C++ exception";
  bool rethrown = false;
  try {
    try {
      throw std::runtime_error(message);
    } catch (const std::runtime_error &active) {
      errno = 0;
      pid_t child = fork();
#if defined(__wasm__)
      int fork_errno = errno;
      if (child >= 0) {
        if (child == 0)
          _exit(1);
        wait_for_success(child);
        fail("fork unexpectedly succeeded during an active exception");
      }
      require(child == -1 && fork_errno == EOPNOTSUPP,
              "active-exception fork did not fail with EOPNOTSUPP");
      require_no_waitable_children();
#else
      require(child >= 0, "native fork during active exception failed");
      if (child == 0)
        _exit(std::strcmp(active.what(), message) == 0 ? 0 : 1);
      wait_for_success(child);
#endif
      require(std::strcmp(active.what(), message) == 0,
              "active exception changed across fork attempt");
      throw;
    }
  } catch (const std::runtime_error &caught) {
    rethrown = std::strcmp(caught.what(), message) == 0;
  }
  require(rethrown, "active exception did not rethrow after fork attempt");

  pid_t child = fork();
  if (child == -1)
    fail("fork after active-exception catch failed");
  if (child == 0)
    _exit(0);
  wait_for_success(child);
}

} // namespace

int main()
{
  std::setvbuf(stdout, nullptr, _IONBF, 0);
  try {
    stage_heap_tls_raii();
    std::puts("fork C++: heap, TLS and RAII state remain independent pass");

    stage_parent_child_exceptions();
    std::puts("fork C++: parent and child exceptions unwind through their own runtime pass");

    stage_active_exception();
    std::puts("fork C++: active exception refusal preserves catch state and later fork pass");
    std::puts("::vm-test::pass");
  } catch (const std::exception &error) {
    std::fprintf(stderr, "fork C++: %s\n", error.what());
    return EXIT_FAILURE;
  } catch (...) {
    std::fputs("fork C++: unexpected non-standard exception\n", stderr);
    return EXIT_FAILURE;
  }

  if (getpid() == 1) {
    for (;;) {
      pause();
    }
  }
  return EXIT_SUCCESS;
}
