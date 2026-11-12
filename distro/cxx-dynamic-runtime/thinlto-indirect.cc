// SPDX-License-Identifier: MIT
using Callback = void (*)();

extern "C" __attribute__((noinline)) void call_indirect(Callback callback)
{
    callback();
}
