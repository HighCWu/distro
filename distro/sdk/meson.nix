# SPDX-License-Identifier: MIT
{ pkgs }:
pkgs.meson.overrideAttrs (old: {
  patches = (if (old.patches or null) == null then [ ] else old.patches) ++ [
    ./meson-wasm-archive-groups.patch
  ];
  postPatch = (if (old.postPatch or null) == null then "" else old.postPatch) + ''
    PYTHONPATH="$PWD" ${pkgs.python3.interpreter} ${./meson-archive-test.py}
  '';
})
