/* SPDX-License-Identifier: MIT */
#include <lua.h>
#include <lauxlib.h>
#include <lualib.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#if defined(__wasm__) && defined(LINUX_WASM_TEST_INIT)
#include <sched.h>
#endif

struct counter { lua_Integer value; };

static int step(lua_State *state)
{
    struct counter *counter = lua_touserdata(state, lua_upvalueindex(1));
    lua_Integer delta = luaL_checkinteger(state, 1);
    /* Keep this fixture's arithmetic inside the signed Lua integer range. */
    if (delta < 0 || delta > 100)
        return luaL_error(state, "delta outside supported range");
    counter->value += delta;
    lua_pushinteger(state, counter->value);
    return 1;
}

static int fail_from_c(lua_State *state)
{
    lua_newtable(state);
    lua_pushinteger(state, 73);
    lua_setfield(state, -2, "code");
    return lua_error(state);
}

int main(void)
{
    int result = EXIT_FAILURE;
    lua_State *state = luaL_newstate();
    if (!state) {
        fputs("Lua embedding: allocation failed\n", stderr);
        puts("::vm-test::fail");
        return result;
    }
    struct counter counter = { (INT64_C(1) << 60) + 123 };
    luaL_openlibs(state);
    lua_pushlightuserdata(state, &counter);
    lua_pushcclosure(state, step, 1);
    lua_setglobal(state, "native_step");
    lua_pushcfunction(state, fail_from_c);
    lua_setglobal(state, "native_fail");
    const char *script =
        "assert(native_step(1) == 1152921504606847100)\n"
        "local ok, why = pcall(native_step, -1)\n"
        "assert(not ok and why:match('delta outside supported range'))\n"
        "local closed = 0\n"
        "local success, cause = pcall(function()\n"
        "  local resource <close> = setmetatable({}, {__close = function(_, err)\n"
        "    assert(err.code == 73); closed = closed + 1\n"
        "  end})\n"
        "  native_fail()\n"
        "end)\n"
        "assert(not success and cause.code == 73 and closed == 1)\n"
        "local thread = coroutine.create(function()\n"
        "  coroutine.yield(native_step(2))\n"
        "  return native_step(3)\n"
        "end)\n"
        "local a, b = coroutine.resume(thread)\n"
        "assert(a and b == 1152921504606847102)\n"
        "local c, d = coroutine.resume(thread)\n"
        "assert(c and d == 1152921504606847105 and coroutine.status(thread) == 'dead')\n"
        "return {answer = native_step(4)}\n";
    if (luaL_loadstring(state, script) != LUA_OK || lua_pcall(state, 0, 1, 0) != LUA_OK) {
        const char *message = lua_tostring(state, -1);
        fprintf(stderr, "Lua embedding: %s\n", message ? message : "non-string Lua error");
        goto done;
    }
    if (!lua_istable(state, -1)) goto done;
    lua_getfield(state, -1, "answer");
    if (!lua_isinteger(state, -1) ||
        lua_tointeger(state, -1) != (INT64_C(1) << 60) + 133 ||
        counter.value != (INT64_C(1) << 60) + 133) goto done;
    result = EXIT_SUCCESS;
done:
    lua_close(state);
    if (result == EXIT_SUCCESS)
        puts("Lua embedding: installed archive, C callbacks, integer64, errors and coroutine verified");
    puts(result == EXIT_SUCCESS ? "::vm-test::pass" : "::vm-test::fail");
    fflush(NULL);
#if defined(__wasm__) && defined(LINUX_WASM_TEST_INIT)
    if (result == EXIT_SUCCESS)
        for (;;) sched_yield();
#endif
    return result;
}
