# SPDX-License-Identifier: MIT
cmake_minimum_required(VERSION 3.20)
project(libcurl_installed_example LANGUAGES C)

find_package(PkgConfig REQUIRED)
# The SDK's pkg-config wrapper includes static private dependencies and
# excludes host package discovery. Do not replace this with hand-written -l flags.
pkg_check_modules(LIBCURL REQUIRED IMPORTED_TARGET libcurl)
add_executable(libcurl-fetch fetch.c)
target_compile_options(libcurl-fetch PRIVATE -Wall -Wextra -Werror)
target_link_libraries(libcurl-fetch PRIVATE PkgConfig::LIBCURL)
set_target_properties(libcurl-fetch PROPERTIES SUFFIX ".wasm")
