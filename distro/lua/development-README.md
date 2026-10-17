<!-- SPDX-License-Identifier: MIT -->

# Embed Lua in a Linux/Wasm application

This development output contains the Lua 5.4 headers, static `liblua.a`,
relocatable `lib/pkgconfig/lua.pc`, original license materials, and this MIT
example. Use a matching wasm32 or wasm64 Linux SDK; the archives are not
interchangeable between pointer widths and cannot be linked as host ELF code.

After copying the entire development output to your chosen prefix:

```sh
export LUA_DEV=/absolute/path/to/copied-lua-dev
export WASM_PKG_CONFIG_PATH="$LUA_DEV/lib/pkgconfig"
export WASM_PKG_CONFIG_SYSROOT_DIR=/
wasm-linux-cc -O2 "$LUA_DEV/share/doc/lua/examples/embedding.c" \
  $(wasm-linux-pkg-config --cflags --libs lua) -o lua-example.wasm
```

Run the resulting program inside Linux/Wasm, for example from its shell:

```sh
./lua-example.wasm
echo "$?"
```

The example registers C callbacks, preserves a 64-bit integer above the exact
floating-point range, propagates Lua/C errors with protected calls, checks
resource cleanup and resumes a coroutine. Success prints a verification stage
and `::vm-test::pass`, then returns exit status 0. The markers are self-test
output, not a host JavaScript API. It is not a WASI executable: do not pass it
directly to Node's Wasm API or a WASI runner.

Only the CI PID-1 variant defines `LINUX_WASM_TEST_INIT`; it intentionally stays
alive after success because returning from Linux init would panic. Do not define
that option for normal applications. The complete example source is installed
here, so building it does not require a checkout of this repository or Lua source.

Static dependencies are selected by `wasm-linux-pkg-config` (including `-lm`).
The SDK supplies musl, compiler-rt and the platform flags. This profile does not
enable shared Lua modules or `dlopen`, implement standard `fork`, or change
the platform's direct linear-memory address model. Keep the original notices
under `share/licenses/lua` with distributed library/program materials; the
example's own MIT terms are in `LICENSE.MIT`. Included notices are not a complete
release-compliance audit and do not relicense dependencies or the Linux kernel.
