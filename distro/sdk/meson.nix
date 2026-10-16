# SPDX-License-Identifier: MIT
{ pkgs }:
pkgs.meson.overrideAttrs (old: {
  patches = (old.patches or [ ]) ++ [ ./meson-wasm-archive-groups.patch ];
  postPatch = (old.postPatch or "") + ''
    PYTHONPATH="$PWD" ${pkgs.python3.interpreter} ${./meson-archive-test.py}
  '';
})
