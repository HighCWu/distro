// SPDX-License-Identifier: MIT
#include <setjmp.h>
#include <stddef.h>
#include <stdint.h>
#include <unistd.h>

extern void perform_longjmp(jmp_buf Environment, int Value);

static int CheckLongJump(int RequestedValue, int ExpectedValue, uint64_t Marker) {
  jmp_buf Environment;
  volatile uint64_t LiveStackState[4] = {0};
  volatile uintptr_t SavedStackAddress = 0;

  switch (setjmp(Environment)) {
  case 0:
    LiveStackState[0] = Marker;
    LiveStackState[1] = ~Marker;
    LiveStackState[2] = Marker ^ UINT64_C(0x9e3779b97f4a7c15);
    LiveStackState[3] = Marker + UINT64_C(0x1020304050607080);
    SavedStackAddress = (uintptr_t)&LiveStackState[0];
    perform_longjmp(Environment, RequestedValue);
    return 1;
  case 1:
    if (ExpectedValue != 1) return 2;
    break;
  case 37:
    if (ExpectedValue != 37) return 2;
    break;
  default:
    return 2;
  }

  if (SavedStackAddress != (uintptr_t)&LiveStackState[0]) return 3;
  if (LiveStackState[0] != Marker) return 4;
  if (LiveStackState[1] != ~Marker) return 5;
  if (LiveStackState[2] != (Marker ^ UINT64_C(0x9e3779b97f4a7c15))) return 6;
  if (LiveStackState[3] != (Marker + UINT64_C(0x1020304050607080))) return 7;
  return 0;
}

static void ReportAndWait(int Passed) {
  static const char Pass[] = "SJLJ_LTO_STACK_AND_RETURN_VALUES_OK\n::vm-test::pass\n";
  static const char Fail[] = "::vm-test::fail\n";
  const char *Message = Passed ? Pass : Fail;
  const size_t Length = Passed ? sizeof(Pass) - 1 : sizeof(Fail) - 1;
  size_t Written = 0;
  while (Written < Length) {
    const ssize_t Amount = write(STDOUT_FILENO, Message + Written, Length - Written);
    if (Amount <= 0) break;
    Written += (size_t)Amount;
  }

  // Keep init alive after the result so the VM runner controls shutdown.
  for (;;) (void)pause();
}

int main(void) {
  int Passed = CheckLongJump(0, 1, UINT64_C(0x123456789abcdef0)) == 0;
  if (Passed) Passed = CheckLongJump(37, 37, UINT64_C(0xfedcba9876543210)) == 0;
  ReportAndWait(Passed);
}
