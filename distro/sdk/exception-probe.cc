// SPDX-License-Identifier: MIT
extern "C" void sdk_throw();
extern "C" void sdk_cleanup();

struct Guard {
    ~Guard() { sdk_cleanup(); }
};

extern "C" int sdk_catch_probe()
{
    try {
        Guard guard;
        sdk_throw();
        return 0;
    } catch (...) {
        return 42;
    }
}
