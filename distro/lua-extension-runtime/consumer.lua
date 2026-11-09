-- SPDX-License-Identifier: MIT

local module_path = assert(arg[1], "expected native module path")
local missing_path = assert(arg[2], "expected missing module path")
local recovery_path = assert(arg[3], "expected recovery module path")

local module_dir = assert(module_path:match("^(.*)/[^/]+$"), "module path must be absolute")
package.cpath = module_dir .. "/?.so;" .. package.cpath

local nativeprobe = require("nativeprobe")
assert(nativeprobe.answer() == 42, "nativeprobe.answer() did not return 42")
assert(nativeprobe.bump(1) == 1, "initial nativeprobe.bump() state is wrong")

local same_module = require("nativeprobe")
assert(rawequal(same_module, nativeprobe), "repeated require returned a different module table")
assert(same_module.bump(2) == 3, "repeated require did not preserve module state")
assert(nativeprobe.bump(0) == 3, "module state did not continue across require")
print("lua extension: standard C module import and resident state pass")

local ok, message = pcall(nativeprobe.fail)
assert(not ok and tostring(message):find("native failure sentinel", 1, true), "native failure did not reach pcall")

ok, message = pcall(nativeprobe.call, function()
  error("callback failure sentinel")
end)
assert(not ok and tostring(message):find("callback failure sentinel", 1, true), "callback failure did not reach pcall")

assert(nativeprobe.local_jump(7) == 7, "local_jump(7) returned the wrong value")
assert(nativeprobe.local_jump(0) == 1, "local_jump(0) did not recover with value 1")
assert(nativeprobe.call(function()
  return nativeprobe.answer()
end) == 42, "normal callback did not recover after errors and longjmp")
assert(nativeprobe.bump(1) == 4, "module state changed across callback error recovery")
print("lua extension: callback errors and cross-module longjmp recovery pass")

local loader, load_error = package.loadlib(missing_path, "luaopen_nativeprobe")
assert(loader == nil and type(load_error) == "string" and #load_error > 0, "missing module load did not fail cleanly")
assert(package.loaded.nativeprobe == nativeprobe, "failed load replaced package.loaded.nativeprobe")

loader, load_error = package.loadlib(recovery_path, "luaopen_nativeprobe")
assert(type(loader) == "function", "valid copied module did not load: " .. tostring(load_error))
local recovered = loader("nativeprobe")
assert(type(recovered) == "table" and recovered.answer() == 42, "recovered module initializer did not work")
assert(recovered.bump(0) == 0, "copied module did not get independent native state")
assert(package.loaded.nativeprobe == nativeprobe, "manual load replaced the resident require result")
assert(nativeprobe.bump(1) == 5, "resident module state did not survive failed and valid explicit loads")
print("lua extension: failed load and later valid load recovery pass")
