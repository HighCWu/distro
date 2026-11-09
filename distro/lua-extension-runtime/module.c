// SPDX-License-Identifier: MIT
#include <limits.h>
#include <setjmp.h>
#include <lua.h>
#include <lauxlib.h>

static lua_Integer counter;

static int answer(lua_State *state)
{
    lua_pushinteger(state, 42);
    return 1;
}

static int bump(lua_State *state)
{
    lua_Integer amount = luaL_checkinteger(state, 1);
    luaL_argcheck(state, amount >= 0 && amount <= LUA_MAXINTEGER - counter,
                  1, "counter increment out of range");
    counter += amount;
    lua_pushinteger(state, counter);
    return 1;
}

static int fail(lua_State *state)
{
    return luaL_error(state, "native failure sentinel");
}

static int call(lua_State *state)
{
    luaL_checktype(state, 1, LUA_TFUNCTION);
    lua_settop(state, 1);
    lua_call(state, 0, 1);
    return 1;
}

__attribute__((noinline)) static _Noreturn void jump_to(jmp_buf buffer, int value)
{
    longjmp(buffer, value);
}

static int local_jump(lua_State *state)
{
    lua_Integer value = luaL_checkinteger(state, 1);
    luaL_argcheck(state, value >= INT_MIN && value <= INT_MAX,
                  1, "longjmp value out of range");
    jmp_buf buffer;
    int result = setjmp(buffer);
    if (!result)
        jump_to(buffer, (int)value);
    lua_pushinteger(state, result);
    return 1;
}

int luaopen_nativeprobe(lua_State *state)
{
    static const luaL_Reg functions[] = {
        { "answer", answer },
        { "bump", bump },
        { "fail", fail },
        { "call", call },
        { "local_jump", local_jump },
        { NULL, NULL }
    };
    luaL_newlib(state, functions);
    return 1;
}
