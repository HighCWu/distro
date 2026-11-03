// SPDX-License-Identifier: MIT
extern int absent_version(int);
__asm__(".symver absent_version, api@VER_MISSING\n");
int missing_version_call(int input) { return absent_version(input); }
