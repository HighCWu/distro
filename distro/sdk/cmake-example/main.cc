// SPDX-License-Identifier: MIT
#include <cstdio>
#include <cstdlib>
#include <sched.h>
#include <thread>
#include <vector>

#ifdef SDK_BUILD_GENERATED_ANSWER
#include "sdk-generated-answer.h"
#else
#define SDK_GENERATED_ANSWER 42
#endif

#ifdef SDK_EXTERNAL_ANSWER
#include <answer.h>
#else
extern "C" int sdk_answer(void);
#endif

int main()
{
    int result = 0;
    std::thread worker([&result] {
        std::vector<int> values{sdk_answer(), SDK_GENERATED_ANSWER - 41};
        result = values[0] + values[1];
    });
    worker.join();
    if (result != 43) {
        std::puts("::vm-test::fail: CMake C archive and C++ consumer result");
        std::fflush(stdout);
        return EXIT_FAILURE;
    }
    std::puts("CMake SDK: C static archive, C++ thread and join verified");
#ifdef SDK_BUILD_GENERATED_ANSWER
    std::puts("CMake SDK: build-machine generator and target consumer verified");
#endif
    std::puts("::vm-test::pass");
    std::fflush(stdout);
#if defined(__wasm__)
    for (;;) sched_yield();
#else
    return 0;
#endif
}
