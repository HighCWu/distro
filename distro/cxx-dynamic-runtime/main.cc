// SPDX-License-Identifier: MIT
#include "shared.hpp"

#include <dlfcn.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <stdexcept>

CrossError::CrossError(int value) noexcept : value_(value) {}

const char *CrossError::what() const noexcept
{
    return "CrossError";
}

int CrossError::value() const noexcept
{
    return value_;
}

namespace {

[[noreturn]] void fail(const char *message)
{
    std::fprintf(stderr, "cxx dynamic runtime failure: %s\n", message);
    std::exit(1);
}

void require(bool condition, const char *message)
{
    if (!condition)
        fail(message);
}

template <typename Function>
Function load_function(void *handle, const char *name)
{
    static_assert(sizeof(Function) == sizeof(void *));
    dlerror();
    void *address = dlsym(handle, name);
    const char *error = dlerror();
    if (error != nullptr)
        fail(error);
    if (address == nullptr)
        fail("dlsym returned a null function address");
    return reinterpret_cast<Function>(address);
}

using ConstructorCountFunction = int (*)();
using StringValueFunction = int (*)(int);
using ThrowRuntimeErrorFunction = void (*)(int *);
using CallbackRethrowFunction = void (*)(MainThrowCallback,
                                         int,
                                         int *,
                                         int *,
                                         int *);

void main_throw_callback(int value, int *cleanup_count)
{
    CleanupGuard guard(*cleanup_count);
    throw CrossError(value);
}

void run(const char *plugin_path)
{
    CrossError canonical_type(0);
    require(canonical_type.value() == 0,
            "main did not retain the canonical CrossError definition");

    void *handle = dlopen(plugin_path, RTLD_NOW | RTLD_LOCAL);
    if (handle == nullptr) {
        const char *error = dlerror();
        fail(error != nullptr ? error : "dlopen failed");
    }

    auto constructor_count =
        load_function<ConstructorCountFunction>(handle, "cxx_plugin_constructor_count");
    auto string_value =
        load_function<StringValueFunction>(handle, "cxx_plugin_string_value");
    auto throw_runtime_error = load_function<ThrowRuntimeErrorFunction>(
        handle, "cxx_plugin_throw_runtime_error");
    auto callback_rethrow = load_function<CallbackRethrowFunction>(
        handle, "cxx_plugin_callback_rethrow");

    require(constructor_count() == 1, "plugin constructor did not run exactly once");
    require(string_value(2) == 10,
            "plugin std::string or new/delete result was incorrect");
    std::puts("cxx dynamic: std::string allocation and DSO constructor pass");

    int runtime_cleanup_count = 0;
    bool caught_runtime_error = false;
    try {
        throw_runtime_error(&runtime_cleanup_count);
    } catch (const std::runtime_error &error) {
        caught_runtime_error = true;
        require(std::strcmp(error.what(), "runtime error from plugin") == 0,
                "caught std::runtime_error message was wrong");
    } catch (...) {
        fail("plugin std::runtime_error was not caught by its type");
    }
    require(caught_runtime_error, "plugin did not throw std::runtime_error");
    require(runtime_cleanup_count == 1,
            "plugin RAII guard was not destroyed during runtime_error unwind");
    std::puts("cxx dynamic: std::runtime_error typed catch and DSO RAII unwind pass");

    int callback_cleanup_count = 0;
    int plugin_cleanup_count = 0;
    int caught_value = -1;
    bool caught_cross_error = false;
    try {
        callback_rethrow(main_throw_callback, 73, &callback_cleanup_count,
                         &plugin_cleanup_count, &caught_value);
    } catch (const CrossError &error) {
        caught_cross_error = true;
        require(error.value() == 73, "re-thrown CrossError value was wrong");
        require(std::strcmp(error.what(), "CrossError") == 0,
                "re-thrown CrossError type information was wrong");
    } catch (...) {
        fail("callback CrossError was not caught by its type in main");
    }
    require(caught_cross_error, "plugin did not re-throw the callback exception");
    require(caught_value == 73,
            "plugin did not catch CrossError by type before re-throwing");
    require(callback_cleanup_count == 1,
            "main callback RAII guard was not destroyed during unwind");
    require(plugin_cleanup_count == 1,
            "plugin RAII guard was not destroyed during re-throw");
    std::puts("cxx dynamic: callback exception typed catch and rethrow across DSOs pass");

    require(string_value(7) == 15,
            "repeated normal plugin call failed after exception recovery");
    int repeated_cleanup_count = 0;
    caught_runtime_error = false;
    try {
        throw_runtime_error(&repeated_cleanup_count);
    } catch (const std::runtime_error &error) {
        caught_runtime_error = true;
        require(std::strcmp(error.what(), "runtime error from plugin") == 0,
                "recovered std::runtime_error message was wrong");
    } catch (...) {
        fail("runtime_error after prior exception was not caught by type");
    }
    require(caught_runtime_error && repeated_cleanup_count == 1,
            "exception recovery call did not complete with RAII cleanup");

    if (dlclose(handle) != 0)
        fail("dlclose failed");
}

} // namespace

int main(int argc, char **argv)
{
    if (argc != 2)
        fail("expected the plugin shared-object path as the only argument");
    run(argv[1]);
    return 0;
}
