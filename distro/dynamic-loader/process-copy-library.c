// SPDX-License-Identifier: MIT
#include <stdint.h>

static int process_copy_value = 17;
static unsigned process_copy_constructors;

__attribute__((constructor)) static void process_copy_initialize(void)
{
  ++process_copy_constructors;
  process_copy_value = 23;
}

int process_copy_get_value(void)
{
  return process_copy_value;
}

void process_copy_set_value(int value)
{
  process_copy_value = value;
}

unsigned process_copy_constructor_count(void)
{
  return process_copy_constructors;
}

int process_copy_call(void)
{
  return process_copy_value * 2;
}
