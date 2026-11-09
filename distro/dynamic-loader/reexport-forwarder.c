// SPDX-License-Identifier: MIT
extern int reexport_target(int);

/* Keep the provider as a real NEEDED dependency of this DSO. */
int reexport_forwarder_anchor(void)
{
    return reexport_target(0);
}
