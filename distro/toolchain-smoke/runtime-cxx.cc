// SPDX-License-Identifier: MIT
#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <exception>
#include <memory>
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

struct RetainedException {
    int *destroyed;
    ~RetainedException() { ++*destroyed; }
};

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
