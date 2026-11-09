// SPDX-License-Identifier: MIT
int plugin_is_GPL_compatible = 1;

int badext_probe_value = 1;

int
badext_probe_function(void)
{
  return badext_probe_value;
}
