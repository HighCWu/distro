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
generator_library = static_library('sdk-generator-answer', 'generator-answer.c', native: true)
generator = executable('sdk-generator', 'generator.c', native: true,
  link_with: generator_library)
header = custom_target('generated-answer', output: 'answer.h',
  command: [generator, '@OUTPUT@'])
dependencies = [dependency('threads')]
if get_option('installed_answer')
  dependencies += dependency('sdk-answer', method: 'pkg-config', static: true)
endif
# A -> B -> a previously unneeded object in A requires archive rescanning on
# GNU ld. wasm-ld resolves it lazily without --start-group/--end-group.
archive_a = static_library('sdk-archive-a', ['archive-entry.c', 'archive-leaf.c'])
archive_b = static_library('sdk-archive-b', 'archive-bridge.c')
executable('sdk-meson', ['main.cc', header],
  link_with: [archive_a, archive_b], dependencies: dependencies, name_suffix: 'wasm')
