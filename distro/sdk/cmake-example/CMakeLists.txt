# SPDX-License-Identifier: MIT
cmake_minimum_required(VERSION 3.20)
project(linux_wasm_sdk_example LANGUAGES C CXX)
include(CheckFunctionExists)
check_function_exists(malloc SDK_HAS_MALLOC)
check_function_exists(linux_wasm_sdk_missing_function SDK_HAS_MISSING_FUNCTION)
if(NOT SDK_HAS_MALLOC OR SDK_HAS_MISSING_FUNCTION)
  message(FATAL_ERROR "SDK function probes must link: malloc exists, the fixture symbol does not")
endif()
find_package(Threads REQUIRED)
option(SDK_USE_INSTALLED_ANSWER "Find the separately installed target library" OFF)
if(SDK_USE_INSTALLED_ANSWER)
  find_package(PkgConfig REQUIRED)
  pkg_check_modules(ANSWER REQUIRED IMPORTED_TARGET sdk-answer)
  add_library(answer ALIAS PkgConfig::ANSWER)
else()
  add_library(answer STATIC answer.c)
  target_compile_features(answer PRIVATE c_std_11)
endif()
add_executable(sdk-example main.cc)
install(TARGETS sdk-example RUNTIME DESTINATION bin)
option(SDK_USE_BUILD_GENERATOR "Run a separately built native code generator" OFF)
if(SDK_USE_BUILD_GENERATOR)
  foreach(tool CC_FOR_BUILD AR_FOR_BUILD RANLIB_FOR_BUILD)
    if("$ENV{${tool}}" STREQUAL "")
      message(FATAL_ERROR "SDK_USE_BUILD_GENERATOR requires ${tool}")
    endif()
    find_program(SDK_NATIVE_${tool} NAMES "$ENV{${tool}}" REQUIRED NO_CMAKE_FIND_ROOT_PATH)
  endforeach()
  set(generator_build "${CMAKE_CURRENT_BINARY_DIR}/build-machine")
  set(generator_source "${CMAKE_CURRENT_SOURCE_DIR}/build-generator")
  set(generator "${generator_build}/sdk-generator")
  set(header "${CMAKE_CURRENT_BINARY_DIR}/sdk-generated-answer.h")
  find_program(SDK_BUILD_NINJA ninja REQUIRED NO_CMAKE_FIND_ROOT_PATH)
  # A second CMake build has its own native cache. In particular, a toolchain
  # file or target flags exported by the calling shell must not reach it.
  add_custom_command(OUTPUT "${generator}"
    COMMAND "${CMAKE_COMMAND}" -E env
      --unset=CMAKE_TOOLCHAIN_FILE --unset=CC --unset=CXX --unset=AR --unset=RANLIB
      --unset=CFLAGS --unset=CXXFLAGS --unset=CPPFLAGS --unset=LDFLAGS
      "${CMAKE_COMMAND}" -S "${generator_source}" -B "${generator_build}" -G Ninja
      "-DCMAKE_MAKE_PROGRAM=${SDK_BUILD_NINJA}"
      "-DCMAKE_C_COMPILER=${SDK_NATIVE_CC_FOR_BUILD}"
      "-DCMAKE_AR=${SDK_NATIVE_AR_FOR_BUILD}" "-DCMAKE_RANLIB=${SDK_NATIVE_RANLIB_FOR_BUILD}"
      -DCMAKE_BUILD_TYPE=Release
    COMMAND "${CMAKE_COMMAND}" --build "${generator_build}"
    DEPENDS "${generator_source}/CMakeLists.txt"
      "${CMAKE_CURRENT_SOURCE_DIR}/../meson-example/generator.c"
      "${CMAKE_CURRENT_SOURCE_DIR}/../meson-example/generator-answer.c"
    VERBATIM)
  add_custom_command(OUTPUT "${header}"
    COMMAND "${generator}" "${header}"
    DEPENDS "${generator}"
    VERBATIM)
  target_sources(sdk-example PRIVATE "${header}")
  target_include_directories(sdk-example PRIVATE "${CMAKE_CURRENT_BINARY_DIR}")
  target_compile_definitions(sdk-example PRIVATE SDK_BUILD_GENERATED_ANSWER=1)
endif()
target_compile_features(sdk-example PRIVATE cxx_std_17)
target_link_libraries(sdk-example PRIVATE answer Threads::Threads)
if(CMAKE_CROSSCOMPILING)
  set_target_properties(sdk-example PROPERTIES SUFFIX ".wasm")
endif()
