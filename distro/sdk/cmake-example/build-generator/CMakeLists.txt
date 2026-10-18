# SPDX-License-Identifier: MIT
cmake_minimum_required(VERSION 3.20)
project(sdk_build_generator LANGUAGES C)
if(CMAKE_CROSSCOMPILING)
  message(FATAL_ERROR "The SDK generator must be built for the build machine")
endif()
# Share the same native-only sources as the Meson example, including its
# rejection of __wasm__ and its actual dependency on a static archive.
add_library(generator-answer STATIC ../../meson-example/generator-answer.c)
add_executable(sdk-generator ../../meson-example/generator.c)
target_link_libraries(sdk-generator PRIVATE generator-answer)
