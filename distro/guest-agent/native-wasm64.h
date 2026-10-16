/* SPDX-License-Identifier: MIT */
/* Fail the standalone native build if its SDK accidentally selects ILP32. */
_Static_assert(sizeof(void *) == 8 && sizeof(long) == 8,
               "native agent requires wasm64 LP64");
