// SPDX-License-Identifier: MIT
#include "shared.hpp"

#include <stdexcept>
#include <string>

namespace {

int constructor_count;

struct ConstructorProbe {
    ConstructorProbe() { ++constructor_count; }
};

ConstructorProbe constructor_probe;

} // namespace

extern "C" int cxx_plugin_constructor_count()
{
    return constructor_count;
}

extern "C" int cxx_plugin_string_value(int value)
{
    std::string text = "plugin:";
    text += std::to_string(value);
    std::string *allocated = new std::string(text);
    int result = static_cast<int>(allocated->size()) + value;
    delete allocated;
    return result;
}

extern "C" void cxx_plugin_throw_runtime_error(int *cleanup_count)
{
    CleanupGuard guard(*cleanup_count);
    throw std::runtime_error("runtime error from plugin");
}

extern "C" void cxx_plugin_callback_rethrow(MainThrowCallback callback,
                                             int value,
                                             int *callback_cleanup_count,
                                             int *plugin_cleanup_count,
                                             int *caught_value)
{
    CleanupGuard guard(*plugin_cleanup_count);
    try {
        callback(value, callback_cleanup_count);
    } catch (const CrossError &error) {
        *caught_value = error.value();
        throw;
    }
}
