#!/bin/busybox sh
# SPDX-License-Identifier: MIT

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

for license in lua-readme.html musl-COPYRIGHT compiler-rt-LICENSE.TXT; do
  test -s "/usr/share/licenses/lua/$license" || fail "missing Lua license: $license"
done

# os.execute/io.popen spawn /bin/sh, which uses the runtime's /dev/null.

# Core language features: arithmetic, strings, tables, and file io.
cat >/tmp/core.lua <<'LUA'
assert(package.path:find("/usr/share/lua/5.4/?.lua", 1, true), "default Lua module path")
assert(package.cpath:find("/usr/lib/lua/5.4/?.so", 1, true), "default C module path")
local platform_test = require("platform_test")
assert(platform_test.answer == 42, "require from /usr/share/lua/5.4")

-- Lua's standard 64-bit integer type is required on both pointer widths.
assert(math.maxinteger == 9223372036854775807, "integer max")
assert(math.mininteger == -9223372036854775807 - 1, "integer min")
local large = (1 << 60) + 123
assert(math.type(large) == "integer" and tostring(large) == "1152921504606847099", "integer precision")
local packed = string.pack("<j", large)
assert(#packed == 8 and string.unpack("<j", packed) == large, "integer binary roundtrip")

assert(2 ^ 10 == 1024, "pow")
assert(7 // 2 == 3, "floordiv")
assert(7 % 3 == 1, "mod")
assert(math.floor(math.sqrt(144)) == 12, "sqrt")

assert(("hello"):upper() == "HELLO", "upper")
assert(string.format("%d-%s-%0.2f", 42, "x", 1.5) == "42-x-1.50", "format")
assert(#"abcde" == 5, "len")
assert(("a,b,c"):gsub(",", ";") == "a;b;c", "gsub")
assert(("  trim  "):match("^%s*(.-)%s*$") == "trim", "match")

local t = {}
for i = 1, 5 do t[i] = i * i end
assert(#t == 5 and t[5] == 25, "table build")
local sum = 0
for _, v in ipairs(t) do sum = sum + v end
assert(sum == 55, "ipairs sum")
table.sort(t, function(a, b) return a > b end)
assert(t[1] == 25 and t[5] == 1, "sort")
local m = { a = 1, b = 2, c = 3 }
local keys = 0
for _ in pairs(m) do keys = keys + 1 end
assert(keys == 3, "pairs")

local path = "/tmp/lua-io.txt"
local w = assert(io.open(path, "w"))
w:write("line1\n")
w:write("line2\n")
w:close()
local r = assert(io.open(path, "r"))
assert(r:read("l") == "line1", "read line")
assert(r:read("a") == "line2\n", "read rest")
r:close()

print("::lua::core-pass")
LUA

lua /tmp/core.lua >/tmp/core.out 2>&1 ||
  fail "lua core script exited nonzero: $(cat /tmp/core.out)"
grep -qx '::lua::core-pass' /tmp/core.out ||
  fail "lua core features failed: $(cat /tmp/core.out)"

# Coroutines and pcall unwind through luaD_throw -> longjmp, which needs the
# SjLj lowering the package is built with; assert they really work.
cat >/tmp/coro.lua <<'LUA'
local co = coroutine.create(function(a)
  local b = coroutine.yield(a + 1)
  return b * 2
end)
local ok1, v1 = coroutine.resume(co, 10)
assert(ok1 and v1 == 11, "yield value")
local ok2, v2 = coroutine.resume(co, 5)
assert(ok2 and v2 == 10, "resume value")
assert(coroutine.status(co) == "dead", "status")

local ok, err = pcall(function() error("boom") end)
assert(not ok and err:match("boom"), "pcall catches error")
local ok2b, err2 = pcall(function() error({ code = 7 }) end)
assert(not ok2b and err2.code == 7, "pcall table error")

local closes = {}
local function resource(name)
  return setmetatable({}, { __close = function(_, cause)
    closes[#closes + 1] = { name = name, cause = cause }
  end })
end
local cause = { code = 19 }
local success, failure = pcall(function()
  local first <close> = resource("first")
  local second <close> = resource("second")
  error(cause)
end)
assert(not success and failure == cause, "unwind keeps error identity")
assert(#closes == 2 and closes[1].name == "second" and closes[2].name == "first", "reverse cleanup order")
assert(closes[1].cause == cause and closes[2].cause == cause, "cleanup receives original error")

local suspended = coroutine.create(function()
  local pending <close> = resource("suspended")
  coroutine.yield("waiting")
end)
local resumed, value = coroutine.resume(suspended)
assert(resumed and value == "waiting" and #closes == 2, "yield preserves live resource")
assert(coroutine.close(suspended), "close suspended coroutine")
assert(#closes == 3 and closes[3].name == "suspended" and closes[3].cause == nil, "coroutine close cleanup")

print("::lua::unwind-pass")
LUA
lua /tmp/coro.lua >/tmp/coro.out 2>&1 ||
  fail "lua coroutine/pcall script exited nonzero: $(cat /tmp/coro.out)"
grep -qx '::lua::unwind-pass' /tmp/coro.out ||
  fail "lua coroutine/pcall failed: $(cat /tmp/coro.out)"

# os.execute (system()) and io.popen (popen()) go through the no-fork spawn
# path; package.loadlib should fail gracefully (no dlopen). Assert the spawn
# results and require an explicit failure for unavailable shared modules.
cat >/tmp/probe.lua <<'LUA'
local ok, how, code = os.execute("exit 3")
assert(ok == nil and how == "exit" and code == 3, "os.execute status")
local ph = assert(io.popen("echo popen-output"), "popen open")
local out = ph:read("a")
assert(out:match("popen%-output"), "popen output")
assert(ph:close(), "popen close")
local library, reason = package.loadlib("/nonexistent.so", "luaopen_x")
assert(library == nil and type(reason) == "string" and #reason > 0, "loadlib explicit failure")
print("::lua::spawn-pass")
LUA
lua /tmp/probe.lua >/tmp/probe.out 2>&1 ||
  fail "lua spawn script exited nonzero: $(cat /tmp/probe.out)"
grep -qx '::lua::spawn-pass' /tmp/probe.out ||
  fail "lua spawn probes failed: $(cat /tmp/probe.out)"

# luac is the target executable, not a build-host bytecode generator. Run both
# ordinary and stripped chunks on the same target that produced them. Binary
# chunks are not promised to be portable across pointer widths or Lua versions.
for strip in normal stripped; do
  for module in core coro; do
    if [ "$strip" = stripped ]; then
      luac -s -o /tmp/$module.luac /tmp/$module.lua || fail "stripped luac compile failed"
    else
      luac -o /tmp/$module.luac /tmp/$module.lua || fail "luac compile failed"
    fi
    lua /tmp/$module.luac >/tmp/bytecode.out 2>&1 || fail "compiled $module failed: $(cat /tmp/bytecode.out)"
    stage=core
    [ "$module" != coro ] || stage=unwind
    grep -qx "::lua::$stage-pass" /tmp/bytecode.out || fail "compiled $module missing stage"
  done
done
printf 'local =\n' >/tmp/invalid.lua
if luac -p /tmp/invalid.lua >/tmp/invalid.out 2>&1; then
  fail "luac accepted invalid source"
fi
head -c 16 /tmp/core.luac >/tmp/truncated.luac
if lua /tmp/truncated.luac >/tmp/truncated.out 2>&1; then
  fail "lua accepted truncated bytecode"
fi

echo "Lua: integer64, modules, I/O, coroutine cleanup, spawn and bytecode roundtrips verified"
echo "::vm-test::pass"
while :; do :; done
