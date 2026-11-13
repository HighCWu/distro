// SPDX-License-Identifier: MIT

extern int loader_maintenance_ctor_entered(void);
extern int loader_maintenance_is_released(void);
extern int loader_maintenance_signal_seen(void);

static int constructor_status = -1;
static int constructor_signal_seen;

__attribute__((constructor)) static void wait_for_timer_worker(void)
{
  // Arm the worker only after the loader has entered this no-yield wait.
  (void)loader_maintenance_ctor_entered();

  while (!loader_maintenance_is_released()) {
    if (loader_maintenance_signal_seen()) constructor_signal_seen = 1;
  }

  constructor_status = 0;
}

int loader_maintenance_ctor_status(void)
{
  return constructor_status;
}

int loader_maintenance_ctor_signal_seen(void)
{
  return constructor_signal_seen;
}
