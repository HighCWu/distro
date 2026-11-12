// SPDX-License-Identifier: MIT
#include <stdint.h>

extern volatile uint32_t scope_memory_main_value;
extern volatile uint32_t scope_memory_main_cookie;
extern uint32_t scope_memory_main_add(uint32_t Delta);

static uint32_t LocalCallCount;

__attribute__((visibility("default"))) uint32_t
scope_memory_library_apply(uint32_t Delta)
{
	if (LocalCallCount != 0 ||
	    scope_memory_main_cookie != UINT32_C(0x2468ace0)) {
		return 0;
	}
	uint32_t Before = scope_memory_main_value;
	uint32_t After = scope_memory_main_add(Delta);
	if (Before + Delta != After) {
		return 0;
	}
	LocalCallCount++;
	return After;
}

__attribute__((visibility("default"))) uint32_t scope_memory_library_calls(void)
{
	return LocalCallCount;
}
