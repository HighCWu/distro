// SPDX-License-Identifier: MIT
#include <gnumake.h>

int plugin_is_GPL_compatible = 1;

int badplugin_gmk_setup(const gmk_floc *floc)
{
  gmk_eval("$(info MAKE_PLUGIN_BAD_INIT_CALLED)", floc);
  return 0;
}
