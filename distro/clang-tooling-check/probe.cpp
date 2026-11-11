// SPDX-License-Identifier: MIT
#include <clang/Frontend/FrontendActions.h>
#include <clang/Tooling/Tooling.h>

#include <iostream>
#include <memory>
#include <string>
#include <vector>

namespace {

constexpr char ABIProbe[] = R"(
#include <stddef.h>
#include <stdint.h>

#if !defined(__linux__)
#error "the selected target must be Linux"
#endif

#if EXPECTED_WASM_BITS == 32
#if !defined(__wasm32__)
#error "the selected target must be wasm32"
#endif
#else
#if !defined(__wasm64__)
#error "the selected target must be wasm64"
#endif
#endif

_Static_assert(sizeof(void *) == EXPECTED_POINTER_BYTES, "target pointer width mismatch");
_Static_assert(sizeof(size_t) == EXPECTED_POINTER_BYTES, "target size_t width mismatch");
_Static_assert(sizeof(unsigned long) == EXPECTED_POINTER_BYTES, "target long width mismatch");
_Static_assert(sizeof(uintptr_t) == EXPECTED_POINTER_BYTES, "SDK stdint uintptr_t width mismatch");
int sdk_header_probe(void) { return 0; }
)";

bool ParseABI(const std::string& Triple, const std::string& Sysroot, unsigned WasmBits,
              unsigned ExpectedPointerBytes, bool Linux64ABI) {
  std::vector<std::string> Arguments {
    "--target=" + Triple,
    "--sysroot=" + Sysroot,
    "-nostdinc",
    "-isystem",
    Sysroot + "/include",
    "-std=c11",
    "-DEXPECTED_WASM_BITS=" + std::to_string(WasmBits),
    "-DEXPECTED_POINTER_BYTES=" + std::to_string(ExpectedPointerBytes),
  };
  if (Linux64ABI) {
    Arguments.emplace_back("-mabi=linux64");
  }

  return clang::tooling::runToolOnCodeWithArgs(
    std::make_unique<clang::SyntaxOnlyAction>(), ABIProbe, Arguments, "sdk-abi-probe.c");
}

} // namespace

int main(int argc, char** argv) {
  if (argc != 3) {
    std::cerr << "usage: clang-tooling-probe <wasm32-sysroot> <wasm64-sysroot>\n";
    return 2;
  }

  const std::string Sysroot32 = argv[1];
  const std::string Sysroot64 = argv[2];
  if (!ParseABI("wasm32-unknown-linux-musl", Sysroot32, 32, 4, false)) {
    std::cerr << "wasm32 Linux sysroot ABI probe failed\n";
    return 1;
  }
  std::cout << "clang-tooling: wasm32 Linux + SDK uintptr_t assertion passed\n";

  if (!ParseABI("wasm64-unknown-linux-musl", Sysroot64, 64, 8, true)) {
    std::cerr << "wasm64 Linux -mabi=linux64 sysroot ABI probe failed\n";
    return 1;
  }
  std::cout << "clang-tooling: wasm64 Linux -mabi=linux64 + SDK uintptr_t assertion passed\n";

  // This deliberately wrong assertion must be rejected by the real target
  // parser, proving that the positive checks are not mere driver invocation.
  if (ParseABI("wasm64-unknown-linux-musl", Sysroot64, 64, 4, true)) {
    std::cerr << "wasm64 negative pointer-width control unexpectedly passed\n";
    return 1;
  }
  std::cout << "clang-tooling: deliberately wrong wasm64 pointer-width assertion rejected\n";
  return 0;
}
