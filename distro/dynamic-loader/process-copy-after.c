// SPDX-License-Identifier: MIT
static unsigned process_copy_after_constructors;

__attribute__((constructor)) static void process_copy_after_initialize(void)
{
  ++process_copy_after_constructors;
}

int process_copy_after_value(void)
{
  return process_copy_after_constructors == 1 ? 73 : -1;
}

unsigned process_copy_after_constructor_count(void)
{
  return process_copy_after_constructors;
}
