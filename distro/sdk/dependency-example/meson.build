# SPDX-License-Identifier: MIT
project('sdk-static-dependency', 'c', default_options: ['c_std=c11'])
static_library('sdk-answer', 'answer.c', install: true)
static_library('sdk-helper', 'helper.c', install: true)
install_headers('answer.h')
configuration = configuration_data()
configuration.set('CMAKE_INSTALL_PREFIX', get_option('prefix'))
configure_file(input: 'sdk-answer.pc.in', output: 'sdk-answer.pc',
  configuration: configuration, install_dir: 'lib/pkgconfig')
