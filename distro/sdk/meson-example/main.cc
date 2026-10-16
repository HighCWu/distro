// SPDX-License-Identifier: MIT
#include "answer.h"
#include <cstdio>
#include <cstdlib>
#include <thread>
extern "C" int sdk_archive_answer(void);
#ifdef SDK_EXTERNAL_ANSWER
extern "C" int sdk_answer(void);
#endif
#ifdef __wasm__
#include <sched.h>
#endif

int main()
{
    int answer = 0;
    std::thread worker([&answer] { answer = SDK_GENERATED_ANSWER; });
    worker.join();
    if (sdk_archive_answer() != 42) {
        std::puts("::vm-test::fail: Meson mutually dependent static archives");
        return EXIT_FAILURE;
    }
#ifdef SDK_EXTERNAL_ANSWER
    if (sdk_answer() != answer) {
        std::puts("::vm-test::fail: Meson installed static dependency");
        return EXIT_FAILURE;
    }
#endif
    if (answer != 42) {
        std::puts("::vm-test::fail: Meson generated header or thread result");
        return EXIT_FAILURE;
    }
    std::puts("SDK Meson: build-machine generator and target C++ thread verified");
    std::puts("::vm-test::pass");
    std::fflush(stdout);
#ifdef __wasm__
    for (;;) sched_yield();
#else
    return EXIT_SUCCESS;
#endif
}
