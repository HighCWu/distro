// SPDX-License-Identifier: MIT
#include <stdint.h>

#ifndef TAIL_STEP
#error "TAIL_STEP must select this library's accumulator"
#endif

#if TAIL_STEP != 1 && TAIL_STEP != 3
#error "TAIL_STEP must be 1 or 3"
#endif

struct Chain {
    uint64_t Remaining;
    uint64_t Value;
    uint64_t (*step_one)(struct Chain *);
    uint64_t (*step_three)(struct Chain *);
};

uint64_t tail_step(struct Chain *chain)
{
    if (chain->Remaining == 0)
        return chain->Value;

    chain->Remaining--;
    chain->Value += TAIL_STEP;
#if TAIL_STEP == 1
    __attribute__((musttail)) return chain->step_three(chain);
#else
    __attribute__((musttail)) return chain->step_one(chain);
#endif
}
