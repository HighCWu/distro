// SPDX-License-Identifier: MIT
extern int reexport_target(int);

/* The initializer emits a GOT/table function-pointer relocation in this DSO. */
static int (*volatile saved_reexport_target)(int) = reexport_target;

int reexport_consumer_direct(int value)
{
    return reexport_target(value);
}

int (*reexport_consumer_pointer(void))(int)
{
    return saved_reexport_target;
}
