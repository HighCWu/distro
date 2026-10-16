# SPDX-License-Identifier: MIT
project('linux-wasm-sdk-example', ['c', 'cpp'],
  default_options: ['c_std=c11', 'cpp_std=c++17', 'warning_level=3', 'werror=true'])
if not meson.is_cross_build() or meson.can_run_host_binaries()
  error('This example requires cross mode without a target execution wrapper')
endif
# Cross probes must link without executing target code. Checking compilation
# alone would incorrectly accept the deliberately unresolved external below.
foreach language : ['c', 'cpp']
  compiler = meson.get_compiler(language)
  if not compiler.links('''
    #include <stdlib.h>
    int main(void) {
      void *(*volatile allocate)(size_t) = malloc;
      void (*volatile release)(void *) = free;
      void *p = allocate(16);
      release(p);
      return 0;
    }
  ''', name: language + ' libc allocation link probe')
    error(language + ' must link libc allocation functions')
  endif
  missing_symbol = '''
    extern int linux_wasm_sdk_missing_function(void);
    int main(void) { return linux_wasm_sdk_missing_function(); }
  '''
  if not compiler.compiles(missing_symbol,
      name: language + ' unresolved symbol compiles')
    error('Missing-symbol fixture must compile before testing link rejection')
  endif
  if compiler.links(missing_symbol,
      name: language + ' unresolved symbol must not link')
    error(language + ' incorrectly accepted an unresolved external symbol')
  endif
endforeach
generator = executable('sdk-generator', 'generator.c', native: true)
header = custom_target('generated-answer', output: 'answer.h',
  command: [generator, '@OUTPUT@'])
executable('sdk-meson', ['main.cc', header],
  dependencies: dependency('threads'), name_suffix: 'wasm')
