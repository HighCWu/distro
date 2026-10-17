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

# Build and installation are separate, ordinary CMake operations. Preserve
# the dependency notices from this development installation, not host copies.
get_filename_component(notice_dir "${CMAKE_CURRENT_SOURCE_DIR}/../../../licenses/curl" ABSOLUTE)
foreach(notice IN ITEMS curl-COPYING integration-MIT zlib.h openssl-LICENSE.txt
    musl-COPYRIGHT compiler-rt-LICENSE.TXT)
  if(NOT EXISTS "${notice_dir}/${notice}")
    message(FATAL_ERROR "Missing installed dependency notice: ${notice}")
  endif()
endforeach()
install(TARGETS libcurl-fetch RUNTIME DESTINATION bin)
install(DIRECTORY "${notice_dir}/" DESTINATION share/licenses/curl)
install(FILES "${CMAKE_CURRENT_SOURCE_DIR}/LICENSE.MIT"
  DESTINATION share/licenses/curl RENAME example-MIT)
