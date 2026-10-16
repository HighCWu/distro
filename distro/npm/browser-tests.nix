{
  basic-init,
  guest-agent,
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
  sdk,
  sdk-wasm64,
  site,
  toolchain-smoke-wasm64,
  toolchain-smoke,
}:

let
  source = ../../packages/browser-tests;
  runtimeTests = [
    "rejects invalid CPU counts before configuring devices or fetching the kernel"
    "runs musl allocation, mmap, threads, TLS and signals"
    "runs C++ containers, exceptions, cross-thread exception_ptr cleanup and TLS"
    "runs SDK SQLite transactions and file reopen through Linux"
    "runs SDK Unix and TCP socket readiness and half-close through Linux"
    "runs SDK time64 relative and absolute timers and ready-fd waits through Linux"
    "runs SDK pthread time64 waits, cancellation and broadcast through Linux"
    "retries a failed kernel download in the same page with a generic MIME type"
  ];

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

  runtimeSuite =
    bits:
    let
      programs = if bits == 64 then toolchain-smoke-wasm64 else toolchain-smoke;
      runtimeKernel = if bits == 64 then kernel-wasm64 else kernel;
      initramfs = image.mkInitramfs {
        name = "wasm${toString bits}-browser-runtime";
        init = "${programs}/smoke-c.wasm";
      };
      cxxInitramfs = image.mkInitramfs {
        name = "wasm${toString bits}-browser-runtime-cxx";
        init = "${programs}/runtime-cxx.wasm";
      };
      sqliteInitramfs = image.mkInitramfs {
        name = "wasm${toString bits}-browser-runtime-sqlite";
        init = (if bits == 64 then sdk-wasm64 else sdk).sqliteProgram;
      };
      socketInitramfs = image.mkInitramfs {
        name = "wasm${toString bits}-browser-runtime-sockets";
        init = (if bits == 64 then sdk-wasm64 else sdk).socketProgram;
      };
      timeInitramfs = image.mkInitramfs {
        name = "wasm${toString bits}-browser-runtime-time";
        init = (if bits == 64 then sdk-wasm64 else sdk).timeProgram;
      };
      threadTimeInitramfs = image.mkInitramfs {
        name = "wasm${toString bits}-browser-runtime-thread-time";
        init = (if bits == 64 then sdk-wasm64 else sdk).threadTimeProgram;
      };
    in
    pkgs.runCommand "wasm${toString bits}-runtime-browser-tests" { } ''
      mkdir -p \
        $out/node_modules/@lowland/bytes \
        $out/node_modules/@lowland/kernel \
        $out/tests
      ${playwright.linkRuntime "$out"}
      cp ${source}/memory64-app.js $out/app.js
      cp ${source}/runtime-smoke.js $out/runtime-smoke.js
      cp ${../vm-test/protocol.js} $out/protocol.js
      cp ${initramfs} $out/runtime.cpio
      cp ${cxxInitramfs} $out/runtime-cxx.cpio
      cp ${sqliteInitramfs} $out/runtime-sqlite.cpio
      cp ${socketInitramfs} $out/runtime-sockets.cpio
      cp ${timeInitramfs} $out/runtime-time.cpio
      cp ${threadTimeInitramfs} $out/runtime-thread-time.cpio
      cp ${source}/memory64-index.html $out/index.html
      cp ${source}/playwright.config.js $out/playwright.config.js
      cp ${source}/server.js $out/server.js
      cp ${source}/memory64-tests/memory64.spec.js $out/tests/
      cp -r ${bytes}/. $out/node_modules/@lowland/bytes/
      cp -r ${runtimeKernel}/. $out/node_modules/@lowland/kernel/
    '';

  suite = baseSuite // {
    checks = lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux (
      (lib.genAttrs projects check)
      // (lib.genAttrs memory64Projects memory64Check)
      // (lib.genAttrs [ "agent-wasm64-chromium" "agent-wasm64-firefox" ] (
        name:
        playwright.mkCheck {
          name = "browser-tests-${name}";
          suite = agentSuite false;
          expectedTests = [ "runs native wasm64 agent sessions, files, processes and cleanup" ];
          project = lib.removePrefix "agent-wasm64-" name;
        }
      ))
      // (lib.genAttrs [ "agent-production-wasm64-chromium" "agent-production-wasm64-firefox" ] (
        name:
        playwright.mkCheck {
          name = "browser-tests-${name}";
          suite = agentSuite true;
          expectedTests = [ "runs native wasm64 production root pivot, files, processes and cleanup" ];
          project = lib.removePrefix "agent-production-wasm64-" name;
        }
      ))
      // (lib.genAttrs [ "agent-public-wasm64-chromium" "agent-public-wasm64-firefox" ] (
        name:
        playwright.mkCheck {
          name = "browser-tests-${name}";
          suite = agentPublicSuite false false;
          expectedTests = [ "boots native wasm64 through public guestAgent image selection" ];
          project = lib.removePrefix "agent-public-wasm64-" name;
        }
      ))
      // (lib.genAttrs [ "agent-public-userland-wasm64-chromium" "agent-public-userland-wasm64-firefox" ]
        (
          name:
          playwright.mkCheck {
            name = "browser-tests-${name}";
            suite = agentPublicSuite true false;
            expectedTests = [ "runs native wasm64 shell through public guestAgent image selection" ];
            project = lib.removePrefix "agent-public-userland-wasm64-" name;
          }
        )
      )
      // (lib.genAttrs [ "agent-public-network-wasm64-chromium" "agent-public-network-wasm64-firefox" ] (
        name:
        playwright.mkCheck {
          name = "browser-tests-${name}";
          suite = agentPublicSuite true true;
          expectedTests = [ "runs native wasm64 HTTP through public agent networking" ];
          project = lib.removePrefix "agent-public-network-wasm64-" name;
        }
      ))
      // (lib.genAttrs [ "agent-minimal-root-wasm64-chromium" "agent-minimal-root-wasm64-firefox" ] (
        name:
        playwright.mkCheck {
          name = "browser-tests-${name}";
          suite = agentMinimalRootSuite;
          expectedTests = [ "boots the fixture-free native wasm64 minimal system root" ];
          project = lib.removePrefix "agent-minimal-root-wasm64-" name;
        }
      ))
      // (lib.genAttrs [ "runtime-wasm32-chromium" "runtime-wasm32-firefox" ] (
        name:
        playwright.mkCheck {
          name = "browser-tests-${name}";
          suite = runtimeSuite 32;
          expectedTests = runtimeTests;
          project = lib.removePrefix "runtime-wasm32-" name;
        }
      ))
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
      suite = runtimeSuite 64;
      expectedTests = runtimeTests;
      project = lib.removePrefix "memory64-" name;
    };

  agentSuite =
    productionRoot:
    let
      runtime =
        if productionRoot then guest-agent.checks.production-wasm64 else guest-agent.checks.runtime-wasm64;
      variant = if productionRoot then "production" else "runtime";
    in
    pkgs.runCommand "agent-${variant}-wasm64-browser-tests"
      {
        nativeBuildInputs = [ pkgs.esbuild ];
      }
      ''
        mkdir -p $out/node_modules/@lowland/bytes $out/node_modules/@lowland/kernel $out/tests
        ${playwright.linkRuntime "$out"}
        esbuild ${../..}/packages/linux-guest/tests/agent-wasm64-suite.ts \
          --bundle --platform=browser --format=esm --target=es2022 \
          --external:@lowland/kernel --external:@lowland/bytes --outfile=$out/agent-suite.js
        cp ${source}/agent-app.js $out/app.js
        cp ${source}/agent-assertions.js $out/agent-assertions.js
        cp ${source}/agent-tests/agent-check.js $out/tests/
        cp ${source}/agent-tests/agent${lib.optionalString productionRoot "-production"}.spec.js $out/tests/
        cp ${source}/memory64-index.html $out/index.html
        cp ${source}/playwright.config.js $out/playwright.config.js
        cp ${source}/server.js $out/server.js
        cp ${runtime.runtimeInitramfs} $out/agent-runtime.cpio
        ${lib.optionalString productionRoot "cp ${runtime.runtimeRootfs} $out/agent-root.erofs"}
        cp -r ${bytes}/. $out/node_modules/@lowland/bytes/
        cp -r ${kernel-wasm64}/. $out/node_modules/@lowland/kernel/
      '';

  agentPublicSuite =
    userland: networking:
    let
      assets =
        if networking then
          guest-agent.checks.public-network-wasm64
        else if userland then
          guest-agent.checks.public-userland-wasm64
        else
          guest-agent.checks.public-wasm64;
      suffix = if networking then "-network" else lib.optionalString userland "-userland";
      variant = "public${suffix}";
    in
    pkgs.runCommand "agent-${variant}-wasm64-browser-tests"
      {
        nativeBuildInputs = [ pkgs.esbuild ];
      }
      ''
        mkdir -p $out/node_modules/@lowland/bytes $out/node_modules/@lowland/kernel $out/tests
        ${playwright.linkRuntime "$out"}
        esbuild ${../..}/packages/linux-guest/tests/agent-wasm64-public-suite.ts \
          --bundle --platform=browser --format=esm --target=es2022 \
          --external:@lowland/kernel --external:@lowland/kernel/plugin \
          --external:@lowland/bytes --outfile=$out/agent-public-suite.js
        cp ${source}/agent-public-app.js $out/app.js
        cp ${source}/agent-assertions.js $out/agent-assertions.js
        cp ${source}/agent-tests/agent-public-check.js $out/tests/
        cp ${source}/agent-tests/agent-public${suffix}.spec.js $out/tests/
        cp ${source}/memory64-index.html $out/index.html
        cp ${source}/playwright.config.js $out/playwright.config.js
        cp ${source}/server.js $out/server.js
        cp ${assets.runtimeBootDisk} $out/agent-boot.img
        cp ${assets.runtimeRootfs} $out/agent-root.erofs
        cp -r ${bytes}/. $out/node_modules/@lowland/bytes/
        cp -r ${kernel-wasm64}/. $out/node_modules/@lowland/kernel/
      '';

  agentMinimalRootSuite =
    let
      assets = guest-agent.checks.minimal-root-wasm64;
    in
    pkgs.runCommand "agent-minimal-root-wasm64-browser-tests"
      {
        nativeBuildInputs = [ pkgs.esbuild ];
      }
      ''
        mkdir -p $out/node_modules/@lowland/bytes $out/node_modules/@lowland/kernel $out/tests
        ${playwright.linkRuntime "$out"}
        esbuild ${../..}/packages/linux-guest/tests/agent-wasm64-minimal-root-suite.ts \
          --bundle --platform=browser --format=esm --target=es2022 \
          --external:@lowland/kernel --external:@lowland/kernel/plugin \
          --external:@lowland/bytes --outfile=$out/agent-minimal-root-suite.js
        cp ${source}/agent-minimal-root-app.js $out/app.js
        cp ${source}/agent-assertions.js $out/agent-assertions.js
        cp ${source}/agent-tests/agent-minimal-root.spec.js $out/tests/
        cp ${source}/memory64-index.html $out/index.html
        cp ${source}/playwright.config.js $out/playwright.config.js
        cp ${source}/server.js $out/server.js
        cp ${assets.runtimeBootDisk} $out/agent-boot.img
        cp ${assets.runtimeRootfs} $out/agent-root.erofs
        cp -r ${bytes}/. $out/node_modules/@lowland/bytes/
        cp -r ${kernel-wasm64}/. $out/node_modules/@lowland/kernel/
      '';

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
      cp ${source}/site-sqlite.js $out/site-sqlite.js
      cp ${source}/site-fs-trace.js $out/site-fs-trace.js
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
    expectedTests = [
      "missing cross-origin isolation stops before disk access or kernel startup"
      "boots and formats a blank persistent disk into the canonical system"
      "falls back to live-only mode when persistent storage is unavailable"
    ];
  };
  serviceWorkerCheck = playwright.mkCheck {
    name = "browser-tests-service-worker";
    project = "chromium";
    suite = serviceWorkerSuite;
  };
in
assert playwright.assertCompatible (source + "/package.json");
suite
