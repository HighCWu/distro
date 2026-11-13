// SPDX-License-Identifier: MIT
#include <errno.h>

#ifndef WORKER_PUBLICATION_AFTER
#define WORKER_PUBLICATION_AFTER 0
#endif

#if WORKER_PUBLICATION_AFTER
int worker_publication_after_value(void)
{
  return 42;
}
#else
extern int worker_publication_release_and_join(void);

static int constructor_runs;
static int constructor_status = -1;

__attribute__((constructor)) static void run_constructor(void)
{
  ++constructor_runs;
  constructor_status = worker_publication_release_and_join();
}

int worker_publication_value(void)
{
  return 42;
}

int worker_publication_constructor_count(void)
{
  return constructor_runs;
}

int worker_publication_constructor_status(void)
{
  return constructor_status;
}
#endif
