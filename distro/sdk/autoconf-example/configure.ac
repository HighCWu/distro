# SPDX-License-Identifier: MIT
AC_INIT([linux-wasm-sdk-example], [1.0])
AC_CONFIG_SRCDIR([main.c])
AC_PROG_CC
AC_ARG_VAR([CC_FOR_BUILD], [build-machine C compiler for executable generators])
AC_ARG_VAR([CFLAGS_FOR_BUILD], [build-machine C compiler flags])
AS_IF([test -z "$CC_FOR_BUILD"], [CC_FOR_BUILD=cc])
AC_CHECK_FUNCS([malloc linux_wasm_sdk_missing_function])
AS_IF([test "x$ac_cv_func_malloc" != xyes || test "x$ac_cv_func_linux_wasm_sdk_missing_function" != xno],
  [AC_MSG_ERROR([function probes must link against the target library])])
# This example deliberately requires cross mode. Real packages may instead
# supply their own verified cross-compilation fallback for runtime probes.
AC_RUN_IFELSE([AC_LANG_PROGRAM([], [return 0;])],
  [AC_MSG_ERROR([configure unexpectedly executed a target program])],
  [AC_MSG_ERROR([configure attempted to execute a target program])],
  [AC_MSG_NOTICE([SDK runtime probe deferred to the target environment])])
AC_CONFIG_FILES([Makefile])
AC_OUTPUT
