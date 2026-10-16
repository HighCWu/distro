// SPDX-License-Identifier: MIT
// No libc headers: inspect the callback registered with libc++abi directly.
struct ThreadObject {
    ~ThreadObject();
};

ThreadObject &thread_object()
{
    thread_local ThreadObject object;
    return object;
}
