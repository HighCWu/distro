<!-- SPDX-License-Identifier: MIT -->

# Installed libcurl C example

`curl.development` and `curl-wasm64.development` provide separate, copyable
development installations containing headers, static curl/OpenSSL/zlib archives,
their pkg-config metadata, the upstream license texts and this MIT example.
Choose the installation and SDK with matching pointer width. The compiler and
its libc sysroot remain SDK dependencies; the development bundle is not itself
a standalone compiler or a runtime image.

After copying the development installation to an absolute `development` path:

```sh
export WASM_PKG_CONFIG_PATH="$development/lib/pkgconfig"
export WASM_PKG_CONFIG_SYSROOT_DIR=/
wasm-linux-cc -O2 $(wasm-linux-pkg-config --cflags libcurl) \
  "$development/share/doc/libcurl/examples/fetch.c" \
  $(wasm-linux-pkg-config --libs libcurl) -o fetch.wasm
```

The command above assumes paths without spaces. The SDK query wrapper always
requests static dependencies and excludes native package search directories.
Use shell arrays when passing flags from paths which require quoting.

Alternatively, the installed example is a normal CMake project:

```sh
export WASM_PKG_CONFIG_PATH="$development/lib/pkgconfig"
export WASM_PKG_CONFIG_SYSROOT_DIR=/
cmake -S "$development/share/doc/libcurl/examples" -B build-fetch -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_TOOLCHAIN_FILE="$sdk/share/cmake/linux-wasm.cmake" \
  -DCMAKE_STAGING_PREFIX="$development"
cmake --build build-fetch
```

Here `sdk` and `development` are absolute matching-width installations. Use a
fresh build directory when changing either. `CMAKE_STAGING_PREFIX` allows the
explicit copied dependency paths outside the libc sysroot; it does not enable
host package discovery. `PkgConfig::LIBCURL` obtains all static dependencies
through the SDK wrapper. The result is `build-fetch/libcurl-fetch.wasm`; CMake
configures and links cross probes without executing the Wasm binary on the host.

Run the compiled application on Linux/Wasm, not as a host Node/WASI program:

```sh
fetch.wasm file:///tmp/input.bin > /tmp/output.bin
fetch.wasm https://server.example/ /path/to/trusted-ca.pem
```

The example writes arbitrary binary response bytes to stdout and reports status
on stderr, then exits normally. It disables proxies, bounds connect/transfer
time, restricts supported protocols, and keeps certificate and hostname checks
enabled. HTTPS is restricted to TLS 1.3 for this example; omission of the CA
argument (or `-`) uses libcurl's default trust configuration. An optional fourth
argument supplies one libcurl resolve entry such as `localhost:9445:127.0.0.1`.
Redirects are not followed. HTTP status is reported, not converted to a transfer
error. A curl error code becomes the process exit code.

This is an installed-library integration example, not a full HTTP client,
production TLS policy or a browser transport bridge. Browser connections remain
subject to the platform's network capabilities; a loopback test does not enable
arbitrary external raw TCP/TLS. Preserve the shipped third-party notices when
redistributing a linked application; the example's MIT license does not
relicense curl, OpenSSL, zlib, musl or compiler-rt.
