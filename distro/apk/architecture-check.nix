# SPDX-License-Identifier: MIT
{ apk, pkgs }:
let
  fixturePackage = arch: {
    isApk = true;
    inherit arch;
    name = "architecture-fixture";
    version = "0-r0";
  };
  repository = arch: {
    isApkRepository = true;
    inherit arch;
    outPath = toString pkgs.emptyFile;
  };
  evaluate =
    arch: packageArch:
    builtins.tryEval (
      (apk.mkSystem {
        name = "architecture-fixture";
        inherit arch;
        repositories = [ (repository arch) ];
        packages = [ (fixturePackage packageArch) ];
      }).drvPath
    );
in
assert (evaluate "wasm32" "wasm32").success;
assert (evaluate "wasm64" "wasm64").success;
assert (evaluate "wasm64" "noarch").success;
assert !(evaluate "wasm64" "wasm32").success;
assert !(evaluate "wasm32" "wasm64").success;
assert !(evaluate "wasm64;invalid" "wasm64;invalid").success;
pkgs.runCommand "apk-system-architecture-check" { } ''
  mkdir $out
''
