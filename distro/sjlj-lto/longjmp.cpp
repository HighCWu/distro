// SPDX-License-Identifier: MIT
#include <setjmp.h>

extern "C" void perform_longjmp(jmp_buf Environment, int Value) {
  longjmp(Environment, Value);
}
