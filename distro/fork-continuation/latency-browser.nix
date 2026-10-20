# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  playwright,
  assets,
}:
assert playwright.assertCompatible ../../packages/browser-tests/package.json;
let
  fontconfig = pkgs.makeFontsConf { fontDirectories = [ pkgs.dejavu_fonts ]; };
  browsers = pkgs.playwright-driver.selectBrowsers {
    withChromium = true;
    withChromiumHeadlessShell = true;
    withFirefox = true;
    withWebkit = false;
    withFfmpeg = false;
    fontconfig_file = fontconfig;
  };
in
pkgs.runCommand "fork-latency-browser-assets" { } ''
  mkdir $out
  cp -r ${assets}/. $out/
  ${playwright.linkRuntime "$out"}
  cp ${./latency-browser-app.js} $out/latency-browser-app.js
  cp ${./latency-server.js} $out/latency-server.js
  cp ${./latency-browser-run.mjs} $out/latency-browser-run.mjs
  cp ${./latency-browser-boot.mjs} $out/latency-browser-boot.mjs
  printf '%s\n' ${lib.escapeShellArg pkgs.playwright-driver.version} > $out/playwright-version.txt
  cat > $out/run-browser-latency <<'SCRIPT'
  #!${pkgs.runtimeShell}
  set -euo pipefail
  export PLAYWRIGHT_BROWSERS_PATH=${browsers}
  export PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu-24.04
  export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true
  export FONTCONFIG_FILE=${fontconfig}
  export __EGL_VENDOR_LIBRARY_FILENAMES=${pkgs.mesa}/share/glvnd/egl_vendor.d/50_mesa.json
  export LIBGL_ALWAYS_SOFTWARE=1
  export LIBGL_DRIVERS_PATH=${pkgs.mesa}/lib/dri
  # Use the same workflow-selected Node for the controller and measured Node.
  exec ${pkgs.coreutils}/bin/timeout --kill-after=10s 1200s node ${placeholder "out"}/latency-browser-run.mjs ${placeholder "out"} "$@"
  SCRIPT
  chmod 0755 $out/run-browser-latency
''
