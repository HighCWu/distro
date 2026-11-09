# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  sysroot,
  name,
  executableArgs,
  sharedArgs ? null,
  cxxArgs ? [ "-lunwind" ],
}:
let
  responseText =
    args: lib.concatMapStringsSep "\n" lib.escapeShellArg args + lib.optionalString (args != [ ]) "\n";
  executableResponse = pkgs.writeText "${name}-wasm-linux-executable.rsp" (
    responseText executableArgs
  );
  sharedResponse =
    if sharedArgs == null then
      null
    else
      pkgs.writeText "${name}-wasm-linux-shared.rsp" (responseText sharedArgs);
  cxxResponse = pkgs.writeText "${name}-wasm-linux-cxx.rsp" (responseText cxxArgs);
in
pkgs.runCommand name
  {
    passthru.licenseSources = sysroot.licenseSources or { };
  }
  ''
    mkdir -p $out
    cp -rs ${sysroot}/. $out/
    chmod u+w $out/lib

    rm -f $out/lib/wasm-linux-executable.rsp
    ln -s ${executableResponse} $out/lib/wasm-linux-executable.rsp

    rm -f $out/lib/wasm-linux-shared.rsp
    ${lib.optionalString (sharedResponse != null) ''
      ln -s ${sharedResponse} $out/lib/wasm-linux-shared.rsp
    ''}

    rm -f $out/lib/wasm-linux-cxx.rsp
    ln -s ${cxxResponse} $out/lib/wasm-linux-cxx.rsp
  ''
