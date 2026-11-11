// SPDX-License-Identifier: MIT
#include <inttypes.h>

#include <set>
#include <type_traits>

#if defined(__wasm__) && !defined(__wasm_linux64__)
#error This consumer requires the explicit linux64 ABI
#endif

static_assert(std::is_same_v<__INT64_TYPE__, int64_t>);
static_assert(std::is_same_v<__UINT64_TYPE__, uint64_t>);
static_assert(std::is_same_v<__INTMAX_TYPE__, intmax_t>);
static_assert(std::is_same_v<__UINTMAX_TYPE__, uintmax_t>);
static_assert(std::is_same_v<int64_t, long>);
static_assert(std::is_same_v<uint64_t, unsigned long>);
static_assert(std::is_same_v<intmax_t, long>);
static_assert(std::is_same_v<uintmax_t, unsigned long>);
static_assert(std::is_same_v<uintptr_t, unsigned long>);
static_assert(std::is_same_v<uint64_t, uintptr_t>);

extern "C" int check_cxx_type_model(void) {
  constexpr uint64_t Marker = UINT64_MAX;
  const std::set<uint64_t> IntegerValues {Marker};
  std::set<uintptr_t> PointerValues;
  PointerValues = IntegerValues;
  return PointerValues.find(static_cast<uintptr_t>(Marker)) != PointerValues.end();
}
