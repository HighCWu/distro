// SPDX-License-Identifier: MIT
#include <cxxabi.h>
#include <cstring>
#include <exception>

#if defined(_LIBCPP_VERSION)
namespace __cxxabiv1 {
struct __cxa_eh_globals;
extern "C" __cxa_eh_globals *__cxa_get_globals_fast();
}
#endif

#if defined(__wasm__)
#define WASM_FORK_CXX_EXPORT __attribute__((export_name("__wasm_fork_cxx_quiescent_v1")))
#else
#define WASM_FORK_CXX_EXPORT
#endif

extern "C" WASM_FORK_CXX_EXPORT int __wasm_fork_cxx_quiescent_v1(void) noexcept
{
	// The pinned Asyncify pass traps when unwinding an active catch. Query
	// the matching libc++abi TLS state before starting that transition.
	const auto *globals = __cxxabiv1::__cxa_get_globals_fast();
	void *caught = nullptr;
	// The selected libc++abi places caughtExceptions at offset zero.
	if (globals)
		std::memcpy(&caught, globals, sizeof caught);
	return std::uncaught_exceptions() == 0 && caught == nullptr;
}
