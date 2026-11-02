// SPDX-License-Identifier: MIT
extern int unavailable_reentrant_symbol(void);
int reentrant_rejected_call(void) { return unavailable_reentrant_symbol(); }
