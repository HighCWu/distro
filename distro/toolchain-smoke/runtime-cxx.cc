// SPDX-License-Identifier: MIT
#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <exception>
#include <memory>
#include <mutex>
#include <numeric>
#include <sched.h>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

static thread_local int tls_value = 41;

[[noreturn]] static void fail(const char *detail)
{
    std::printf("::vm-test::fail: C++ runtime: %s\n", detail);
    std::fflush(stdout);
    std::exit(EXIT_FAILURE);
}

struct Guard {
    int &destroyed;
    ~Guard() { ++destroyed; }
};

static void condition_variable_probe()
{
    std::mutex mutex;
    std::condition_variable changed;
    bool ready = false;
    bool work = false;
    bool complete = false;
    int result = 0;
    std::thread worker([&] {
        std::unique_lock<std::mutex> lock(mutex);
        ready = true;
        changed.notify_one();
        if (!changed.wait_for(lock, std::chrono::seconds(10), [&] { return work; }))
            fail("condition variable worker timed out");
        result = 73;
        complete = true;
        changed.notify_one();
    });
    {
        std::unique_lock<std::mutex> lock(mutex);
        if (!changed.wait_for(lock, std::chrono::seconds(10), [&] { return ready; }))
            fail("condition variable readiness timed out");
        work = true;
        changed.notify_one();
        if (!changed.wait_for(lock, std::chrono::seconds(10), [&] { return complete; }))
            fail("condition variable completion timed out");
        if (result != 73) fail("condition variable result visibility");
    }
    worker.join();
}

struct ThreadCleanup {
    int &destroyed;
    int order;
    ~ThreadCleanup()
    {
        if (destroyed != order) fail("thread_local destructor order");
        ++destroyed;
    }
};

static void thread_cleanup_probe()
{
    // Repeated thread creation must register fresh per-thread destructors.
    // The referenced counter remains alive until join completes.
    for (int iteration = 0; iteration < 2; ++iteration) {
        int destroyed = 0;
        std::thread worker([&] {
            thread_local ThreadCleanup first{destroyed, 1};
            thread_local ThreadCleanup second{destroyed, 0};
            if (&first.destroyed != &destroyed || &second.destroyed != &destroyed)
                fail("thread_local initialization retained another thread's state");
            if (destroyed != 0) fail("thread_local destroyed before thread exit");
        });
        worker.join();
        if (destroyed != 2) fail("thread_local destructors missing at join");
    }
}

struct RetainedException {
    int *destroyed;
    ~RetainedException() { ++*destroyed; }
};

struct ExceptionPrefix {
    virtual ~ExceptionPrefix() = default;
    int tag = 73;
};

struct DerivedException : ExceptionPrefix, std::runtime_error {
    int &destroyed;
    explicit DerivedException(int &count)
        : std::runtime_error("derived-exception"), destroyed(count) {}
    ~DerivedException() override { ++destroyed; }
};

static void inherited_exception_probe()
{
    int destroyed = 0;
    bool caught = false;
    try {
        throw DerivedException(destroyed);
    } catch (const std::exception &base) {
        const auto *derived = dynamic_cast<const DerivedException *>(&base);
        const auto *prefix = dynamic_cast<const ExceptionPrefix *>(&base);
        caught = derived && prefix && prefix->tag == 73 &&
                 std::string(base.what()) == "derived-exception";
        if (destroyed != 0) fail("derived exception destroyed during catch");
    }
    if (!caught || destroyed != 1)
        fail("base exception matching, RTTI adjustment or derived destruction");
}

static void retained_exception_probe()
{
    int destroyed = 0;
    std::exception_ptr retained;
    try {
        throw RetainedException{&destroyed};
    } catch (const RetainedException &) {
        retained = std::current_exception();
    }
    if (!retained || destroyed != 0)
        fail("exception_ptr did not retain the thrown object");
    bool caught = false;
    std::thread worker([&] {
        try {
            std::rethrow_exception(retained);
        } catch (const RetainedException &error) {
            caught = error.destroyed == &destroyed;
        } catch (...) {
            fail("exception_ptr changed exception type across threads");
        }
    });
    worker.join();
    if (!caught || destroyed != 0)
        fail("cross-thread exception_ptr rethrow or lifetime");
    retained = nullptr;
    if (destroyed != 1)
        fail("retained exception destructor must run exactly once");
}

[[gnu::noinline]] static void unwind_probe(int &destroyed)
{
    Guard guard{destroyed};
    throw std::runtime_error("sdk-runtime-probe");
}

int main()
{
    try {
        auto values = std::make_unique<std::vector<std::uint64_t>>(
            std::initializer_list<std::uint64_t>{9, 1, 4, 2});
        std::sort(values->begin(), values->end());
        if (*values != std::vector<std::uint64_t>({1, 2, 4, 9}) ||
            std::accumulate(values->begin(), values->end(), UINT64_C(0)) != 16)
            fail("container allocation or algorithms");

        int destroyed = 0;
        bool caught = false;
        try {
            unwind_probe(destroyed);
        } catch (const std::runtime_error &error) {
            caught = std::string(error.what()) == "sdk-runtime-probe";
        }
        if (!caught || destroyed != 1)
            fail("typed exception catch or RAII unwinding");

        std::puts("C++ runtime: typed catch and RAII cleanup passed");
        std::fflush(stdout);
        retained_exception_probe();
        std::puts("C++ runtime: retained cross-thread exception cleanup passed");
        std::fflush(stdout);

        inherited_exception_probe();
        std::puts("C++ runtime: inherited exception and RTTI adjustment passed");
        std::fflush(stdout);

        thread_cleanup_probe();
        std::puts("C++ runtime: thread_local exit cleanup passed");
        std::fflush(stdout);

        condition_variable_probe();
        std::puts("C++ runtime: condition variable handoff passed");
        std::fflush(stdout);

        tls_value = 17;
        std::uint64_t result = 0;
        std::thread worker([&result] {
            try {
                if (tls_value != 41) fail("worker TLS initial value");
                tls_value = 99;
                std::vector<std::uint64_t> local{5, 3, 8};
                result = std::accumulate(local.begin(), local.end(), UINT64_C(0));
            } catch (...) {
                fail("unexpected worker exception");
            }
        });
        worker.join();
        // join synchronizes the result; no unsynchronized polling is needed.
        if (worker.joinable() || result != 16 || tls_value != 17)
            fail("thread join, result visibility or TLS isolation");
    } catch (...) {
        fail("unexpected main exception");
    }
    std::puts("C++ runtime: containers, RAII, exception_ptr, thread and TLS verified");
    std::puts("::vm-test::pass");
    std::fflush(stdout);
#if defined(__wasm__)
    for (;;) sched_yield();
#else
    return 0;
#endif
}
