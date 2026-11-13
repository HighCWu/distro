# SPDX-License-Identifier: MIT
{
  pkgs,
  platform,
  sdk,
  vm-test,
  cc ? "${sdk}/bin/wasm-linux-cc",
  cxx ? "${sdk}/bin/wasm-linux-c++",
}:
let
  program =
    pkgs.runCommand "sjlj-lto-${platform.wasmArch}"
      {
        nativeBuildInputs = [ sdk ];
        passthru.checks.runtime = vm-test.rawInitramfsTest {
          name = "sjlj-lto-${platform.wasmArch}";
          init = "${program}/sjlj-lto.wasm";
          cpus = 1;
        };
      }
      ''
        mkdir -p $out/share/sjlj-lto
        ${cc} -O2 -flto=thin -fPIE -Wall -Wextra -Werror \
          -c ${./main.c} -o main.o
        ${cxx} -O2 -flto=thin -fno-exceptions -fPIE -Wall -Wextra -Werror \
          -c ${./longjmp.cpp} -o longjmp.o
        ${cxx} -O2 -flto=thin -fno-exceptions -fPIE -pie main.o longjmp.o \
          -o $out/sjlj-lto.wasm

        cp ${./main.c} ${./longjmp.cpp} ${./package.nix} $out/share/sjlj-lto/
        cp ${../sdk/LICENSE.MIT} $out/share/sjlj-lto/LICENSE.MIT
      '';
in
program
