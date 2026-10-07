{
  basic-init,
  bytes,
  image,
  lib,
  kernel,
  kernel-wasm64,
  linux,
  linux-wasm64,
  mmap-benchmark,
  mmap-benchmark-wasm64,
  linux-guest,
  pkgs,
  playwright,
  repository,
  site,
}:

let
  source = ../../packages/browser-tests;

  baseSuite = pkgs.runCommand "browser-tests" { } ''
    mkdir -p \
      $out/node_modules/@lowland/bytes \
      $out/node_modules/@lowland/kernel \
      $out/node_modules/@lowland/guest
    ${playwright.linkRuntime "$out"}
    cp ${source}/app.js $out/app.js
    cp ${source}/index.html $out/index.html
    cp ${source}/playwright.config.js $out/playwright.config.js
    cp ${site.package}/static/*/opfs-disk-worker.js $out/opfs-disk-worker.js
    cp ${image.bootInitramfs} $out/boot.cpio
    cp ${basic-init.schedulerHandoffDisk} $out/scheduler-handoff.erofs
    cp ${basic-init.remoteMemoryDisk} $out/remote-vm.erofs
    cp ${basic-init.posixSpawnStressDisk} $out/posix-spawn-stress.erofs
    cp ${source}/server.js $out/server.js
    cp ${linux-guest.package.checks.tests.assets}/rootfs.erofs $out/rootfs.erofs
    mkdir $out/tests
    cp ${source}/tests/boot.spec.js $out/tests/
    cp ${source}/tests/opfs-disk.spec.js $out/tests/
    cp ${source}/tests/posix-spawn-stress.spec.js $out/tests/
    cp ${source}/tests/remote-memory.spec.js $out/tests/
    cp ${source}/tests/spawn-stress.spec.js $out/tests/
    cp ${source}/tests/virtio-fs.spec.js $out/tests/
    cp -r ${bytes}/. $out/node_modules/@lowland/bytes/
    cp -r ${kernel}/. $out/node_modules/@lowland/kernel/
    tar -xzf ${linux-guest.package}/package.tgz --strip-components=1 -C $out/node_modules/@lowland/guest
  '';

  memory64Suite = pkgs.runCommand "memory64-browser-tests" { } ''
    mkdir -p \
      $out/node_modules/@lowland/bytes \
      $out/node_modules/@lowland/kernel \
      $out/tests
    ${playwright.linkRuntime "$out"}
    cp ${source}/memory64-app.js $out/app.js
    cp ${source}/memory64-index.html $out/index.html
    cp ${source}/playwright.config.js $out/playwright.config.js
    cp ${source}/server.js $out/server.js
    cp ${source}/memory64-tests/memory64.spec.js $out/tests/
    cp -r ${bytes}/. $out/node_modules/@lowland/bytes/
    cp -r ${kernel-wasm64}/. $out/node_modules/@lowland/kernel/
  '';

  suite = baseSuite // {
    checks = lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux (
      (lib.genAttrs projects check)
      // (lib.genAttrs memory64Projects memory64Check)
      // (lib.genAttrs erofsProjects erofsCheck)
      // {
        site-live = siteCheck;
        service-worker = serviceWorkerCheck;
      }
    );
  };

  projects = [
    "chromium"
    "firefox"
    "webkit"
  ];

  memory64Projects = [
    "memory64-chromium"
    "memory64-firefox"
  ];

  check =
    project:
    playwright.mkCheck {
      name = "browser-tests-${project}";
      suite = baseSuite;
      inherit project;
    };

  memory64Check =
    name:
    playwright.mkCheck {
      name = "browser-tests-${name}";
      suite = memory64Suite;
      project = lib.removePrefix "memory64-" name;
    };

  erofsProjects = [
    "erofs-wasm32-chromium"
    "erofs-wasm32-firefox"
    "erofs-wasm64-chromium"
    "erofs-wasm64-firefox"
  ];

  erofsSuite =
    bits:
    let
      assets = (if bits == 32 then mmap-benchmark else mmap-benchmark-wasm64).erofsBrowserAssets;
      testKernel = (if bits == 32 then kernel else kernel-wasm64).override {
        linux = (if bits == 32 then linux else linux-wasm64).override { mmapCopyTest = true; };
      };
    in
    pkgs.runCommand "erofs-wasm${toString bits}-browser-tests" { } ''
      mkdir -p $out/node_modules/@lowland/bytes $out/node_modules/@lowland/kernel $out/tests
      ${playwright.linkRuntime "$out"}
      cp ${source}/erofs-app.js $out/app.js
      cp ${source}/memory64-index.html $out/index.html
      cp ${source}/playwright.config.js $out/playwright.config.js
      cp ${source}/server.js $out/server.js
      cp ${source}/erofs-tests/erofs.spec.js $out/tests/
      cp ${../vm-test/protocol.js} $out/protocol.js
      cp ${assets.initramfs} $out/erofs.cpio
      cp ${assets.disk} $out/erofs.img
      cp ${assets.errors.initramfs} $out/erofs-errors.cpio
      cp ${assets.errors.disk} $out/erofs-errors.img
      cp -r ${bytes}/. $out/node_modules/@lowland/bytes/
      cp -r ${testKernel}/. $out/node_modules/@lowland/kernel/
    '';

  erofsCheck =
    name:
    let
      bits = if lib.hasInfix "wasm64" name then 64 else 32;
    in
    playwright.mkCheck {
      name = "browser-tests-${name}";
      suite = erofsSuite bits;
      project = if lib.hasSuffix "chromium" name then "chromium" else "firefox";
    };

  siteSuite = pkgs.runCommand "site-browser-tests" { } ''
      mkdir -p $out/tests
      ${playwright.linkRuntime "$out"}
      cp ${source}/playwright.config.js $out/playwright.config.js
      cp ${source}/server.js $out/server.js
      cp ${source}/tests/site-live.spec.js $out/tests/site-live.spec.js
      cp -rL ${site.package}/. $out/
      # Production and previews fetch the independently published repository.
      # The integration test vendors the exact candidate repository so it can
      # validate an install before those packages have reached production.
      cp -rL ${repository} $out/apk
      # After installation the service worker controls the page, so Playwright's
      # page-level route cannot intercept guest fetches. Route only this test
      # artifact's package requests to the vendored candidate repository; the
      # production worker continues to fetch assets.low.land directly.
      substituteInPlace $out/service-worker.js \
        --replace-fail '  const { request } = event;' '  let { request } = event;' \
        --replace-fail '  const url = new URL(request.url);' '  let url = new URL(request.url);
    if (url.hostname === "assets.low.land" && url.pathname.startsWith("/apk/")) {
      request = new Request(new URL(url.pathname + url.search, location.origin), request);
      url = new URL(request.url);
    }'
  '';

  serviceWorkerSuite = pkgs.runCommand "service-worker-browser-tests" { } ''
    mkdir -p $out/tests
    ${playwright.linkRuntime "$out"}
    cp ${source}/playwright.config.js $out/playwright.config.js
    cp ${source}/server.js $out/server.js
    cp ${source}/app.js $out/app.js
    cp ${source}/tests/service-worker.spec.js $out/tests/service-worker.spec.js
    cp ${source}/index.html $out/index.html
    cp ${../../apps/site/service-worker.js} $out/service-worker.js
  '';

  siteCheck = playwright.mkCheck {
    name = "browser-tests-site-live";
    project = "chromium";
    suite = siteSuite;
  };
  serviceWorkerCheck = playwright.mkCheck {
    name = "browser-tests-service-worker";
    project = "chromium";
    suite = serviceWorkerSuite;
  };
in
assert playwright.assertCompatible (source + "/package.json");
suite
