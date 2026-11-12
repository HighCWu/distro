// SPDX-License-Identifier: MIT
#include <cstdio>

using Callback = void (*)();
extern "C" void call_indirect(Callback callback);

extern "C" __attribute__((noinline)) void throw_value()
{
    throw 42;
}

int main()
{
    try {
        call_indirect(throw_value);
    } catch (int value) {
        if (value != 42)
            return 1;
        std::puts("cxx thinlto: indirect call exception recovered pass");
        return 0;
    } catch (...) {
        return 2;
    }
    return 3;
}
