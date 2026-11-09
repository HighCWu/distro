# SPDX-License-Identifier: MIT
{
  platform,
  python,
  stdenv-fork-automatic,
  sdk-fork-automatic,
  busybox,
  vm-test,
  extraChecks ? { },
}:
let
  basePython = python.override {
    stdenv = stdenv-fork-automatic;
    enableForkContinuation = true;
  };
  package = basePython.overrideAttrs (old: {
    pname = "python-fork";

    postBuild = (old.postBuild or "") + ''
      grep -qx '#define HAVE_FORK 1' pyconfig.h
      grep -qx 'MODULE__POSIXSUBPROCESS_STATE=yes' Makefile
      cmp ${python.src}/Modules/_posixsubprocess.c Modules/_posixsubprocess.c
      cmp ${python.src}/Modules/posixmodule.c Modules/posixmodule.c
      cmp ${python.src}/Lib/subprocess.py Lib/subprocess.py
      cmp ${python.src}/Lib/multiprocessing/popen_fork.py Lib/multiprocessing/popen_fork.py
    '';

    postInstall = (old.postInstall or "") + ''
      notices=$out/share/licenses/python
      install -Dm644 ${sdk-fork-automatic.buildMaterials}/licenses/SDK-MIT.txt \
        "$notices/FORK-SDK-MIT.txt"
      install -Dm644 ${sdk-fork-automatic.buildMaterials}/licenses/Binaryen-LICENSE \
        "$notices/Binaryen-LICENSE"

      materials=$buildMaterials/share/python-fork-materials
      mkdir -p "$materials"
      cp ${./package.nix} ${./runtime.py} ${./runtime-test.sh} "$materials/"
      ln -s ${sdk-fork-automatic.buildMaterials} "$materials/automatic-fork-sdk"
    '';

    passthru = (old.passthru or { }) // {
      checks = {
        runtime = vm-test.rawInitramfsTest {
          name = "python-standard-fork-${platform.wasmArch}";
          init = ./runtime-test.sh;
          contents = [
            busybox
            package
          ];
          files = {
            "/python-fork-runtime.py" = ./runtime.py;
            "/python-abi-test.py" = ../python/abi-test.py;
            "/python-address-bits" = builtins.toFile "python-fork-address-bits" (
              toString platform.addressBits + "\n"
            );
          };
          cpus = 2;
        };
      }
      // extraChecks;
    };
  });
in
package
