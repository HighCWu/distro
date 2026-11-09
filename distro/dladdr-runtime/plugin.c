// SPDX-License-Identifier: MIT
#define _GNU_SOURCE

typedef int (*dladdr_runtime_function) (int);

__attribute__ ((visibility ("default")))
int
dladdr_plugin_function (int value)
{
  return value * 3 + 7;
}

__attribute__ ((visibility ("default")))
unsigned char dladdr_plugin_data[16] = {
  0x10, 0x21, 0x32, 0x43, 0x54, 0x65, 0x76, 0x87,
  0x98, 0xa9, 0xba, 0xcb, 0xdc, 0xed, 0xfe, 0x0f
};

static __attribute__ ((noinline, used)) int
dladdr_plugin_hidden_function (int value)
{
  return value ^ 0x5a5a;
}

__attribute__ ((visibility ("default")))
dladdr_runtime_function
dladdr_plugin_hidden_pointer (void)
{
  return dladdr_plugin_hidden_function;
}
