# SPDX-License-Identifier: MIT
cmake_minimum_required(VERSION 3.20)
project(clang_tooling_check LANGUAGES CXX)

find_package(LLVM REQUIRED CONFIG PATHS "${LLVM_DIR}" NO_DEFAULT_PATH)
find_package(Clang REQUIRED CONFIG PATHS "${Clang_DIR}" NO_DEFAULT_PATH)

if(NOT TARGET clang-cpp)
  message(FATAL_ERROR "The development toolchain did not export the clang-cpp target")
endif()

add_executable(clang-tooling-probe probe.cpp)
target_include_directories(clang-tooling-probe SYSTEM PRIVATE ${LLVM_INCLUDE_DIRS} ${CLANG_INCLUDE_DIRS})
separate_arguments(LLVM_DEFINITIONS_LIST NATIVE_COMMAND "${LLVM_DEFINITIONS}")
target_compile_options(clang-tooling-probe PRIVATE ${LLVM_DEFINITIONS_LIST})
target_link_libraries(clang-tooling-probe PRIVATE clang-cpp)
install(TARGETS clang-tooling-probe RUNTIME DESTINATION bin)
