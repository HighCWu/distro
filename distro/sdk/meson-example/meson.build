# SPDX-License-Identifier: MIT
project('linux-wasm-sdk-example', ['c', 'cpp'],
  default_options: ['c_std=c11', 'cpp_std=c++17', 'warning_level=3', 'werror=true'])
if not meson.is_cross_build() or meson.can_run_host_binaries()
  error('This example requires cross mode without a target execution wrapper')
endif
generator = executable('sdk-generator', 'generator.c', native: true)
header = custom_target('generated-answer', output: 'answer.h',
  command: [generator, '@OUTPUT@'])
executable('sdk-meson', ['main.cc', header],
  dependencies: dependency('threads'), name_suffix: 'wasm')
