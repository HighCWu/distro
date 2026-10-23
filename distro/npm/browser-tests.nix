{
  basic-init,
  bash-fork-wasm64,
  guest-agent,
  bytes,
  curl,
  curl-wasm64,
  dash-fork,
  dash-fork-wasm64,
  fork-continuation,
  fork-continuation-wasm64,
  git,
  git-wasm64,
  image,
  lib,
  kernel,
  kernel-wasm64,
  linux,
  linux-wasm64,
  lua,
  lua-wasm64,
  mmap-benchmark,
  mmap-benchmark-wasm64,
  linux-guest,
  openssl,
  openssl-wasm64,
  pkgs,
  playwright,
  python,
  python-wasm64,
  quickjs,
  quickjs-wasm64,
  repository,
  sdk,
  sdk-wasm64,
  site,
  toolchain-smoke-wasm64,
  toolchain-smoke,
  wasm64-example,
  wasm64-python-example,
  wasm64-python-git-example,
  zstd,
  zstd-wasm64,
}:

let
  source = ../../packages/browser-tests;
  # Keep test dependencies and fixtures outside the verified application bundle.
  exampleServer =
    bundle:
    pkgs.writeText "example-test-server.js" ''
      import "${bundle}/server.mjs";
    '';
  runtimeTests = [
    "rejects invalid CPU counts before configuring devices or fetching the kernel"
    "runs musl allocation, mmap, threads, TLS and signals"
    "runs C++ containers, exceptions, cross-thread exception_ptr cleanup and TLS"
    "runs SDK SQLite transactions and file reopen through Linux"
    "runs SDK Unix and TCP socket readiness and half-close through Linux"
    "runs SDK time64 relative and absolute timers and ready-fd waits through Linux"
    "runs SDK pthread time64 waits, cancellation and broadcast through Linux"
    "runs SDK ppoll, pselect and sigsuspend signal-mask handoff through Linux"
    "runs SDK partial pipe I/O and interrupted child reaping through Linux"
    "runs SDK futex signal restart and timed interruption through Linux"
    "runs SDK futex time64 waits, wake operations and waitv through Linux"
    "runs SDK robust mutex owner-death recovery through Linux"
    "runs SDK named and unnamed semaphore deadline boundaries through Linux"
    "runs SDK C++ filesystem copies, links, time64 metadata and errors through Linux"
    "runs QuickJS language, file I/O, spawn, Worker, timers and bytecode through Linux"
    "runs Lua integer64, modules, coroutine cleanup, spawn and bytecode through Linux"
    "runs installed Lua C callbacks, errors and coroutine through Linux"
    "runs OpenSSL CLI and verified TLS1.3 certificate and hostname checks through Linux"
    "runs curl verified TLS1.3 and certificate/hostname rejection over Linux TCP"
    "runs installed libcurl C binary callbacks and verified TLS1.3 through Linux"
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
      luaAssets = (if bits == 64 then lua-wasm64 else lua).runtimeAssets;
      opensslAssets = (if bits == 64 then openssl-wasm64 else openssl).runtimeAssets;
      curlAssets = (if bits == 64 then curl-wasm64 else curl).runtimeAssets;
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
      signalWaitInitramfs = image.mkInitramfs {
        name = "wasm${toString bits}-browser-runtime-signal-waits";
        init = (if bits == 64 then sdk-wasm64 else sdk).signalWaitProgram;
      };
      signalIoInitramfs = image.mkInitramfs {
        name = "wasm${toString bits}-browser-runtime-signal-io";
        init = (if bits == 64 then sdk-wasm64 else sdk).signalIoProgram;
      };
      signalFutexInitramfs = image.mkInitramfs {
        name = "wasm${toString bits}-browser-runtime-signal-futex";
        init = (if bits == 64 then sdk-wasm64 else sdk).signalFutexProgram;
      };
      futexInitramfs = image.mkInitramfs {
        name = "wasm${toString bits}-browser-runtime-futex";
        init = (if bits == 64 then sdk-wasm64 else sdk).futexProgram;
      };
      robustMutexInitramfs = image.mkInitramfs {
        name = "wasm${toString bits}-browser-runtime-robust-mutex";
        init = (if bits == 64 then sdk-wasm64 else sdk).robustMutexProgram;
      };
      semaphoreDeadlineInitramfs = image.mkInitramfs {
        name = "wasm${toString bits}-browser-runtime-semaphore-deadline";
        init = (if bits == 64 then sdk-wasm64 else sdk).semaphoreDeadlineProgram;
      };
      filesystemInitramfs = image.mkInitramfs {
        name = "wasm${toString bits}-browser-runtime-filesystem";
        init = (if bits == 64 then sdk-wasm64 else sdk).filesystemProgram;
      };
      luaDevelopmentInitramfs = image.mkInitramfs {
        name = "wasm${toString bits}-browser-runtime-lua-development";
        init = luaAssets.developmentProgram;
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
      cp ${signalWaitInitramfs} $out/runtime-signal-waits.cpio
      cp ${signalIoInitramfs} $out/runtime-signal-io.cpio
      cp ${signalFutexInitramfs} $out/runtime-signal-futex.cpio
      cp ${futexInitramfs} $out/runtime-futex.cpio
      cp ${robustMutexInitramfs} $out/runtime-robust-mutex.cpio
      cp ${semaphoreDeadlineInitramfs} $out/runtime-semaphore-deadline.cpio
      cp ${filesystemInitramfs} $out/runtime-filesystem.cpio
      cp ${(if bits == 64 then quickjs-wasm64 else quickjs).browserInitramfs} $out/runtime-quickjs.cpio
      cp ${luaAssets.languageInitramfs} $out/runtime-lua.cpio
      cp ${luaDevelopmentInitramfs} $out/runtime-lua-development.cpio
      cp ${opensslAssets.cliInitramfs} $out/runtime-openssl.cpio
      cp ${curlAssets.httpsInitramfs} $out/runtime-curl-https.cpio
      cp ${curlAssets.developmentInitramfs} $out/runtime-libcurl-development.cpio
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
          suite = agentSystemRootSuite "minimal";
          expectedTests = [ "boots the fixture-free native wasm64 minimal system root" ];
          project = lib.removePrefix "agent-minimal-root-wasm64-" name;
        }
      ))
      // (lib.genAttrs [ "agent-persistent-root-wasm64-chromium" "agent-persistent-root-wasm64-firefox" ]
        (
          name:
          playwright.mkCheck {
            name = "browser-tests-${name}";
            suite = agentSystemRootSuite "persistent";
            expectedTests = [
              "persists native wasm64 ext4 root data across fresh browser machines"
              "persists native wasm64 ext4 root through OPFS across page reload"
            ];
            project = lib.removePrefix "agent-persistent-root-wasm64-" name;
          }
        )
      )
      // (lib.genAttrs [ "agent-sqlite-root-wasm64-chromium" "agent-sqlite-root-wasm64-firefox" ] (
        name:
        playwright.mkCheck {
          name = "browser-tests-${name}";
          suite = agentSystemRootSuite "sqlite";
          expectedTests = [
            "runs installed wasm64 SQLite across fresh browser ext4 root instances"
            "persists installed wasm64 SQLite through OPFS across page reload"
          ];
          project = lib.removePrefix "agent-sqlite-root-wasm64-" name;
        }
      ))
      // (lib.genAttrs [ "agent-python-git-root-wasm64-chromium" "agent-python-git-root-wasm64-firefox" ]
        (
          name:
          playwright.mkCheck {
            name = "browser-tests-${name}";
            suite = pythonGitRootSuite false;
            expectedTests = [
              "runs Python Git SQLite collaboration across fresh browser wasm64 roots"
            ];
            project = lib.removePrefix "agent-python-git-root-wasm64-" name;
          }
        )
      )
      // (lib.genAttrs
        [ "agent-python-git-opfs-root-wasm64-chromium" "agent-python-git-opfs-root-wasm64-firefox" ]
        (
          name:
          playwright.mkCheck {
            name = "browser-tests-${name}";
            suite = pythonGitRootSuite true;
            expectedTests = [
              "persists Python Git SQLite workspace through OPFS across page reload"
            ];
            project = lib.removePrefix "agent-python-git-opfs-root-wasm64-" name;
          }
        )
      )
      // (lib.genAttrs [ "wasm64-example-chromium" "wasm64-example-firefox" ] (
        name:
        playwright.mkCheck {
          name = "browser-tests-${name}";
          suite = wasm64ExampleSuite;
          expectedTests = [ "embeds native wasm64 Linux using the standalone example controls" ];
          project = lib.removePrefix "wasm64-example-" name;
        }
      ))
      // (lib.genAttrs [ "wasm64-python-example-chromium" "wasm64-python-example-firefox" ] (
        name:
        playwright.mkCheck {
          name = "browser-tests-${name}";
          suite = wasm64PythonExampleSuite;
          expectedTests = [ "runs a Python zip application through standalone browser controls" ];
          project = lib.removePrefix "wasm64-python-example-" name;
        }
      ))
      // (lib.genAttrs [ "wasm64-python-git-example-chromium" "wasm64-python-git-example-firefox" ] (
        name:
        playwright.mkCheck {
          name = "browser-tests-${name}";
          suite = wasm64PythonGitExampleSuite;
          expectedTests = [
            "runs a Python Git SQLite workspace through standalone browser controls"
            "restores a Python Git SQLite workspace through standalone OPFS controls"
          ];
          project = lib.removePrefix "wasm64-python-git-example-" name;
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
      // (lib.genAttrs
        [
          "process-altstack-wasm32-chromium"
          "process-altstack-wasm32-firefox"
          "process-altstack-wasm64-chromium"
          "process-altstack-wasm64-firefox"
          "process-stacklegacy-wasm32-chromium"
          "process-stacklegacy-wasm32-firefox"
          "process-stacklegacy-wasm64-chromium"
          "process-stacklegacy-wasm64-firefox"
          "process-useraccess-wasm64-chromium"
          "process-useraccess-wasm64-firefox"
          "process-upper32-wasm32-chromium"
          "process-upper32-wasm32-firefox"
          "process-bash-wasm64-chromium"
          "process-bash-wasm64-firefox"
          "process-dash-wasm64-chromium"
          "process-dash-wasm64-firefox"
          "process-pidfd-wasm64-chromium"
          "process-pidfd-wasm64-firefox"
          "process-execfd-wasm64-chromium"
          "process-execfd-wasm64-firefox"
        ]
        (
          name:
          let
            corpus =
              if lib.hasInfix "-altstack-" name then
                "altstack"
              else if lib.hasInfix "-stacklegacy-" name then
                "stacklegacy"
              else if lib.hasInfix "-upper32-" name then
                "upper32"
              else if lib.hasInfix "-useraccess-" name then
                "useraccess"
              else if lib.hasInfix "-bash-" name then
                "bash"
              else if lib.hasInfix "-dash-" name then
                "dash"
              else if lib.hasInfix "-execfd-" name then
                "execfd"
              else
                "pidfd";
            bits = if lib.hasInfix "-wasm32-" name then 32 else 64;
          in
          playwright.mkCheck {
            name = "browser-tests-${name}";
            suite = processSuite bits corpus;
            project = lib.removePrefix "process-${corpus}-wasm${toString bits}-" name;
            script = "process-browser-check.mjs";
          }
        )
      )
      // (lib.genAttrs
        [
          "fork-wasm32-chromium"
          "fork-wasm32-firefox"
          "fork-wasm64-chromium"
          "fork-wasm64-firefox"
        ]
        (
          name:
          let
            bits = if lib.hasInfix "wasm64" name then 64 else 32;
          in
          playwright.mkCheck {
            name = "browser-tests-${name}";
            suite = forkSuite bits;
            project = lib.removePrefix "fork-wasm${toString bits}-" name;
            script = "fork-browser-check.mjs";
          }
        )
      )
      // {
        fork-wasm64-chromium-stability =
          (playwright.mkCheck {
            name = "browser-tests-fork-wasm64-chromium-stability";
            suite = forkSuite 64;
            project = "chromium";
            script = "fork-browser-check.mjs";
          }).overrideAttrs
            { FORK_BROWSER_STABILITY = "1"; };
      }
      // (lib.genAttrs
        [
          "python-wasm32-chromium"
          "python-wasm32-firefox"
          "python-wasm64-chromium"
          "python-wasm64-firefox"
        ]
        (
          name:
          let
            bits = if lib.hasInfix "wasm64" name then 64 else 32;
          in
          playwright.mkCheck {
            name = "browser-tests-${name}";
            suite = pythonSuite bits;
            expectedTests = [
              "runs installed full Python and relocated applications through Linux"
              "runs installed Python private anonymous mmap boundaries through Linux"
            ];
            project = lib.removePrefix "python-wasm${toString bits}-" name;
          }
        )
      )
      // (lib.genAttrs fileMmapProjects fileMmapCheck)
      // (lib.genAttrs
        [ "git-wasm32-chromium" "git-wasm32-firefox" "git-wasm64-chromium" "git-wasm64-firefox" ]
        (
          name:
          let
            bits = if lib.hasInfix "wasm64" name then 64 else 32;
          in
          playwright.mkCheck {
            name = "browser-tests-${name}";
            suite = gitSuite bits;
            expectedTests = [
              "runs installed Git commits, conflict merges, hooks and pager through Linux"
              "runs installed Git threaded repack, fsck and gc through Linux"
              "runs installed Git credential cache and loopback HTTP clone through Linux"
            ];
            project = lib.removePrefix "git-wasm${toString bits}-" name;
          }
        )
      )
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

  processSuite =
    bits: corpus:
    let
      assets =
        if corpus == "altstack" then
          (if bits == 64 then toolchain-smoke-wasm64 else toolchain-smoke)
          .checks.signal-altstack.runtimeAssets
        else if corpus == "stacklegacy" then
          (if bits == 64 then toolchain-smoke-wasm64 else toolchain-smoke)
          .checks.signal-stack-legacy.runtimeAssets
        else if corpus == "upper32" then
          assert bits == 32;
          toolchain-smoke.checks.user-access-upper32.runtimeAssets
        else if corpus == "useraccess" then
          (if bits == 64 then toolchain-smoke-wasm64 else toolchain-smoke).checks.user-access.runtimeAssets
        else if corpus == "bash" then
          assert bits == 64;
          bash-fork-wasm64.checks.runtime.runtimeAssets
        else if corpus == "dash" then
          (if bits == 64 then dash-fork-wasm64 else dash-fork).checks.runtime.runtimeAssets
        else if corpus == "execfd" then
          (if bits == 64 then fork-continuation-wasm64 else fork-continuation).checks.exec-fd.runtimeAssets
        else if corpus == "pidfd" then
          (if bits == 64 then fork-continuation-wasm64 else fork-continuation)
          .checks.process-control.runtimeAssets
        else
          throw "unknown process browser corpus: ${corpus}";
      profile = pkgs.writeText "process-profile.json" (
        builtins.toJSON {
          addressBits = bits;
          inherit corpus;
          inherit (assets) cpus;
        }
      );
    in
    assert
      assets.disks == [ ]
      &&
        assets.cpus == (
          if
            builtins.elem corpus [
              "upper32"
              "useraccess"
              "altstack"
              "stacklegacy"
            ]
          then
            1
          else
            2
        );
    pkgs.runCommand "${corpus}-wasm${toString bits}-browser-suite" { } ''
      mkdir -p $out/node_modules/@lowland/kernel $out/node_modules/@lowland/bytes
      ${playwright.linkRuntime "$out"}
      cp ${source}/process-app.js $out/app.js
      cp ${source}/process-browser-check.mjs $out/process-browser-check.mjs
      cp ${source}/process-contract.js $out/process-contract.js
      cp ${source}/runtime-smoke.js $out/runtime-smoke.js
      cp ${../vm-test/protocol.js} $out/protocol.js
      cp ${source}/memory64-index.html $out/index.html
      cp ${source}/server.js $out/server.js
      cp ${profile} $out/profile.json
      cp ${assets.initramfs} $out/runtime.cpio
      cp -r ${bytes}/. $out/node_modules/@lowland/bytes/
      cp -r ${(if bits == 64 then kernel-wasm64 else kernel)}/. $out/node_modules/@lowland/kernel/
    '';

  forkSuite =
    bits:
    let
      runtime = if bits == 64 then fork-continuation-wasm64 else fork-continuation;
      assets = runtime.checks.runtime.runtimeAssets;
      faultAssets = runtime.checks.faults.runtimeAssets;
      faultKernel = (if bits == 64 then kernel-wasm64 else kernel).override { copyFaultTest = true; };
      signalAssets = runtime.checks.signals.runtimeAssets;
      signalKernel = (if bits == 64 then kernel-wasm64 else kernel).override { forkSignalTest = true; };
      resumeSignalAssets = runtime.checks.resume-signals.runtimeAssets;
      resumeSignalKernel = (if bits == 64 then kernel-wasm64 else kernel).override {
        forkResumeSignalTest = true;
      };
      childSignalAssets = runtime.checks.child-signals.runtimeAssets;
      childSignalKernel = (if bits == 64 then kernel-wasm64 else kernel).override {
        forkChildSignalTest = true;
      };
      profile = pkgs.writeText "fork-browser-profile.json" (builtins.toJSON { addressBits = bits; });
    in
    assert lib.assertMsg (
      assets.disks == [ ]
      && assets.cpus == 2
      && faultAssets.disks == [ ]
      && faultAssets.cpus == 2
      && signalAssets.disks == [ ]
      && signalAssets.cpus == 2
      && resumeSignalAssets.disks == [ ]
      && resumeSignalAssets.cpus == 2
      && childSignalAssets.disks == [ ]
      && childSignalAssets.cpus == 2
    ) "fork browser fixture requires two CPUs and no disks";
    pkgs.runCommand "fork-wasm${toString bits}-browser-tests" { } ''
      mkdir -p $out/node_modules/@lowland/bytes $out/node_modules/@lowland/kernel
      ${playwright.linkRuntime "$out"}
      cp ${source}/fork-app.js $out/app.js
      cp ${source}/fork-browser-check.mjs $out/fork-browser-check.mjs
      cp ${source}/fork-contract.js $out/fork-contract.js
      cp ${source}/runtime-smoke.js $out/runtime-smoke.js
      cp ${../vm-test/protocol.js} $out/protocol.js
      cp ${source}/memory64-index.html $out/index.html
      cp ${source}/server.js $out/server.js
      cp ${profile} $out/profile.json
      cp ${assets.initramfs} $out/runtime.cpio
      cp ${faultAssets.initramfs} $out/faults.cpio
      cp ${signalAssets.initramfs} $out/signals.cpio
      cp ${resumeSignalAssets.initramfs} $out/resume-signals.cpio
      cp ${childSignalAssets.initramfs} $out/child-signals.cpio
      cp -r ${bytes}/. $out/node_modules/@lowland/bytes/
      cp -r ${(if bits == 64 then kernel-wasm64 else kernel)}/. $out/node_modules/@lowland/kernel/
      mkdir -p $out/node_modules/@lowland/kernel-faults
      cp -r ${faultKernel}/. $out/node_modules/@lowland/kernel-faults/
      mkdir -p $out/node_modules/@lowland/kernel-signals
      cp -r ${signalKernel}/. $out/node_modules/@lowland/kernel-signals/
      mkdir -p $out/node_modules/@lowland/kernel-resume-signals
      cp -r ${resumeSignalKernel}/. $out/node_modules/@lowland/kernel-resume-signals/
      mkdir -p $out/node_modules/@lowland/kernel-child-signals
      cp -r ${childSignalKernel}/. $out/node_modules/@lowland/kernel-child-signals/
    '';

  gitSuite =
    bits:
    let
      runtime = if bits == 64 then git-wasm64 else git;
      variants = [
        "workflow"
        "packing"
        "remote"
      ];
      assets = lib.genAttrs variants (name: runtime.checks.${name}.runtimeAssets);
      profile = pkgs.writeText "git-browser-profile.json" (builtins.toJSON { addressBits = bits; });
    in
    assert lib.assertMsg (lib.all (
      name: builtins.length assets.${name}.disks == 1
    ) variants) "Git browser checks require exactly one installed root disk";
    pkgs.runCommand "git-wasm${toString bits}-browser-tests" { } ''
      mkdir -p $out/node_modules/@lowland/bytes $out/node_modules/@lowland/kernel $out/tests
      ${playwright.linkRuntime "$out"}
      cp ${source}/git-app.js $out/app.js
      cp ${source}/git-tests/git.spec.js $out/tests/
      cp ${source}/runtime-smoke.js $out/runtime-smoke.js
      cp ${../vm-test/protocol.js} $out/protocol.js
      cp ${source}/memory64-index.html $out/index.html
      cp ${source}/playwright.config.js $out/playwright.config.js
      cp ${source}/server.js $out/server.js
      cp ${profile} $out/profile.json
      ${lib.concatMapStringsSep "\n" (variant: ''
        cp ${assets.${variant}.initramfs} $out/runtime-${variant}.cpio
        cp ${builtins.head assets.${variant}.disks} $out/root-${variant}.ext4
      '') variants}
      cp -r ${bytes}/. $out/node_modules/@lowland/bytes/
      cp -r ${(if bits == 64 then kernel-wasm64 else kernel)}/. $out/node_modules/@lowland/kernel/
    '';

  pythonSuite =
    bits:
    let
      runtime = if bits == 64 then python-wasm64 else python;
      assets = lib.genAttrs [ "interpreter" "mmap" ] (name: runtime.checks.${name}.runtimeAssets);
      profile = pkgs.writeText "python-browser-profile.json" (builtins.toJSON { addressBits = bits; });
    in
    assert lib.assertMsg (lib.all (name: builtins.length assets.${name}.disks == 1) [
      "interpreter"
      "mmap"
    ]) "Python browser checks require exactly one installed root disk";
    pkgs.runCommand "python-wasm${toString bits}-browser-tests" { } ''
      mkdir -p $out/node_modules/@lowland/bytes $out/node_modules/@lowland/kernel $out/tests
      ${playwright.linkRuntime "$out"}
      cp ${source}/python-app.js $out/app.js
      cp ${source}/python-tests/python.spec.js $out/tests/
      cp ${source}/runtime-smoke.js $out/runtime-smoke.js
      cp ${../vm-test/protocol.js} $out/protocol.js
      cp ${source}/memory64-index.html $out/index.html
      cp ${source}/playwright.config.js $out/playwright.config.js
      cp ${source}/server.js $out/server.js
      cp ${profile} $out/profile.json
      cp ${assets.interpreter.initramfs} $out/runtime-interpreter.cpio
      cp ${builtins.head assets.interpreter.disks} $out/root-interpreter.ext4
      cp ${assets.mmap.initramfs} $out/runtime-mmap.cpio
      cp ${builtins.head assets.mmap.disks} $out/root-mmap.ext4
      cp -r ${bytes}/. $out/node_modules/@lowland/bytes/
      cp -r ${(if bits == 64 then kernel-wasm64 else kernel)}/. $out/node_modules/@lowland/kernel/
    '';

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

  pythonGitRootSuite =
    persistence:
    let
      assets = guest-agent.checks.python-git-root-wasm64;
      opfsWorker = import ../site/opfs-disk-worker.nix {
        inherit bytes pkgs;
        kernel = kernel-wasm64;
      };
    in
    pkgs.runCommand
      "agent-python-git${lib.optionalString persistence "-opfs"}-root-wasm64-browser-tests"
      {
        nativeBuildInputs = [ pkgs.esbuild ];
      }
      ''
        mkdir -p $out/node_modules/@lowland/bytes $out/node_modules/@lowland/kernel $out/tests
        ${playwright.linkRuntime "$out"}
        esbuild ${../..}/packages/linux-guest/tests/agent-wasm64-python-git-root-suite.ts \
          --bundle --platform=browser --format=esm --target=es2022 \
          --external:@lowland/kernel --external:@lowland/kernel/plugin \
          --external:@lowland/bytes --outfile=$out/agent-python-git-root-suite.js
        cp ${source}/agent-python-git-root-app.js $out/app.js
        cp ${source}/agent-assertions.js $out/agent-assertions.js
        cp ${source}/agent-tests/agent-python-git${lib.optionalString persistence "-opfs"}-root.spec.js $out/tests/
        cp ${source}/memory64-index.html $out/index.html
        cp ${source}/playwright.config.js $out/playwright.config.js
        cp ${source}/server.js $out/server.js
        cp ${assets.runtimeBootDisk} $out/agent-boot.img
        cp ${assets.runtimeRootfs} $out/agent-root.ext4
        cp ${../python/git-workspace-example.py} $out/git-workspace-example.py
        cp ${opfsWorker}/opfs-disk-worker.js $out/opfs-disk-worker.js
        cp ${../../apps/site/opfs-device.js} $out/opfs-device.js
        cp -r ${bytes}/. $out/node_modules/@lowland/bytes/
        cp -r ${kernel-wasm64}/. $out/node_modules/@lowland/kernel/
      '';

  wasm64ExampleSuite = pkgs.runCommand "wasm64-example-browser-tests" { } ''
    mkdir -p $out/tests
    cp -r ${wasm64-example}/. $out/
    # The copied store directory is read-only; add test-only dependency links
    # without changing permissions on the installed application's payloads.
    chmod u+w $out/node_modules
    ${playwright.linkRuntime "$out"}
    cp ${exampleServer wasm64-example} $out/server.js
    cp ${source}/playwright.config.js $out/playwright.config.js
    cp ${source}/agent-tests/wasm64-example.spec.js $out/tests/
    ${sdk-wasm64}/bin/wasm-linux-cc -Wall -Wextra -Werror \
      ${../../apps/wasm64-example}/program-check.c -o $out/upload-program.wasm
  '';

  wasm64PythonExampleSuite = pkgs.runCommand "wasm64-python-example-browser-tests" { } ''
    mkdir -p $out/tests
    cp -r ${wasm64-python-example}/. $out/
    chmod u+w $out/node_modules
    ${playwright.linkRuntime "$out"}
    cp ${exampleServer wasm64-python-example} $out/server.js
    cp ${source}/playwright.config.js $out/playwright.config.js
    cp ${source}/agent-tests/wasm64-python-example.spec.js $out/tests/
    cp ${python-wasm64.applicationExample}/application.pyz $out/upload-application.pyz
    ${pkgs.python313}/bin/python3 -c \
      'import pathlib, sys, zipfile; entry = zipfile.ZipInfo("__main__.py", (1980, 1, 1, 0, 0, 0)); entry.create_system = 3; entry.external_attr = 0o100644 << 16; entry.compress_type = zipfile.ZIP_DEFLATED; z = zipfile.ZipFile(sys.argv[2], "w"); z.writestr(entry, pathlib.Path(sys.argv[1]).read_bytes()); z.close()' \
      ${../../apps/wasm64-example}/python-check.py $out/python-controls.pyz
  '';

  wasm64PythonGitExampleSuite = pkgs.runCommand "wasm64-python-git-example-browser-tests" { } ''
    mkdir -p $out/tests
    cp -r ${wasm64-python-git-example}/. $out/
    chmod u+w $out/node_modules
    ${playwright.linkRuntime "$out"}
    cp ${exampleServer wasm64-python-git-example} $out/server.js
    cp ${source}/playwright.config.js $out/playwright.config.js
    cp ${source}/agent-tests/wasm64-python-git-example.spec.js $out/tests/
  '';

  agentSystemRootSuite =
    profile:
    let
      assets = guest-agent.checks."${profile}-root-wasm64";
      rootFilename = "agent-root.${if profile == "minimal" then "erofs" else "ext4"}";
      opfsWorker = import ../site/opfs-disk-worker.nix {
        inherit bytes pkgs;
        kernel = kernel-wasm64;
      };
    in
    pkgs.runCommand "agent-${profile}-root-wasm64-browser-tests"
      {
        nativeBuildInputs = [ pkgs.esbuild ];
      }
      ''
        mkdir -p $out/node_modules/@lowland/bytes $out/node_modules/@lowland/kernel $out/tests
        ${playwright.linkRuntime "$out"}
        esbuild ${../..}/packages/linux-guest/tests/agent-wasm64-${profile}-root-suite.ts \
          --bundle --platform=browser --format=esm --target=es2022 \
          --external:@lowland/kernel --external:@lowland/kernel/plugin \
          --external:@lowland/bytes --outfile=$out/agent-${profile}-root-suite.js
        cp ${source}/agent-${profile}-root-app.js $out/app.js
        cp ${source}/agent-assertions.js $out/agent-assertions.js
        cp ${source}/agent-tests/agent-${profile}-root.spec.js $out/tests/
        cp ${source}/memory64-index.html $out/index.html
        cp ${source}/playwright.config.js $out/playwright.config.js
        cp ${source}/server.js $out/server.js
        cp ${assets.runtimeBootDisk} $out/agent-boot.img
        cp ${assets.runtimeRootfs} $out/${rootFilename}
        ${lib.optionalString (profile == "persistent" || profile == "sqlite") ''
          cp ${opfsWorker}/opfs-disk-worker.js $out/opfs-disk-worker.js
        ''}
        ${lib.optionalString (profile == "sqlite") ''
          cp ${../../apps/site/opfs-device.js} $out/opfs-device.js
        ''}
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

  fileMmapProjects = [
    "file-mmap-wasm32-chromium"
    "file-mmap-wasm32-firefox"
    "file-mmap-wasm64-chromium"
    "file-mmap-wasm64-firefox"
  ];
  fileMmapSuite =
    bits:
    let
      assets = (if bits == 32 then mmap-benchmark else mmap-benchmark-wasm64).fileBrowserAssets;
      zstdAssets = (if bits == 32 then zstd else zstd-wasm64).checks.file.browserAssets;
      testKernel = (if bits == 32 then kernel else kernel-wasm64).override {
        linux = (if bits == 32 then linux else linux-wasm64).override { fileMmapCandidate = true; };
      };
    in
    pkgs.runCommand "file-mmap-wasm${toString bits}-browser-tests" { } ''
      mkdir -p $out/node_modules/@lowland/bytes $out/node_modules/@lowland/kernel $out/tests
      ${playwright.linkRuntime "$out"}
      cp ${source}/erofs-app.js $out/app.js
      cp ${source}/memory64-index.html $out/index.html
      cp ${source}/playwright.config.js $out/playwright.config.js
      cp ${source}/server.js $out/server.js
      cp ${source}/file-mmap-tests/file-mmap.spec.js $out/tests/
      cp ${../vm-test/protocol.js} $out/protocol.js
      cp ${assets.initramfs} $out/file-mmap.cpio
      cp ${assets.disk} $out/file-mmap.img
      cp ${zstdAssets.initramfs} $out/zstd-mmap.cpio
      cp ${zstdAssets.disk} $out/zstd-mmap.img
      cp -r ${bytes}/. $out/node_modules/@lowland/bytes/
      cp -r ${testKernel}/. $out/node_modules/@lowland/kernel/
    '';
  fileMmapCheck =
    name:
    playwright.mkCheck {
      name = "browser-tests-${name}";
      suite = fileMmapSuite (if lib.hasInfix "wasm64" name then 64 else 32);
      project = if lib.hasSuffix "chromium" name then "chromium" else "firefox";
      expectedTests = [
        "standard immutable file mmap preserves content, offsets and refusal semantics"
        "Zstandard forces immutable dictionary mmap and rejects unsupported sources"
      ];
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
