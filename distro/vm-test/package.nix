# Build-platform test harness: boots the kernel under Node and asserts on a
# pass marker. See docs/architecture.md, "Testing".
{
  apk,
  pkgs,
  lib,
  image,
  kernel,
}:

let
  runnerBase = pkgs.runCommand "vm-test-runner" { } ''
    mkdir $out
    cp ${./protocol.js} $out/protocol.js
    cp ${./run-test.js} $out/run-test.js
    cp ${./shutdown.js} $out/shutdown.js
    cp ${./ninep-host.js} $out/ninep-host.js
  '';

  runner = runnerBase // {
    checks.protocol =
      pkgs.runCommand "vm-test-protocol-check"
        {
          nativeBuildInputs = [ pkgs.nodejs ];
        }
        ''
          cp ${./protocol.js} protocol.js
          cp ${./protocol-test.js} protocol-test.js
          cp ${./shutdown.js} shutdown.js
          cp ${./shutdown-test.js} shutdown-test.js
          cp ${./run-test.js} run-test.js
          cp ${./shutdown-fixture.js} shutdown-fixture.js
          cp ${./runner-shutdown-test.js} runner-shutdown-test.js

          node --test protocol-test.js shutdown-test.js runner-shutdown-test.js
          mkdir $out
        '';
  };

  # Low-level boot runner. It is deliberately private: callers construct an
  # APK-installed root with installedTest/installedDisk instead of supplying
  # an ad-hoc userspace image.
  bootInstalledSystem =
    {
      name,
      initramfs,
      disk ? null,
      disks ? [ ],
      cpus ? 1,
      heavy ? false,
      snapshotFirstDisk ? false,
      readOnlyDisks ? false,
      nodeArguments ? [ ],
      vsockRoundtrip ? false,
      ninepExport ? null,
      ninepMemory ? false,
      recordRuntimeLog ? false,
    }:
    let
      allDisks = lib.optional (disk != null) disk ++ disks;
      diskCopies = lib.imap0 (index: source: {
        inherit index source;
        name = "disk-${toString index}.img";
      }) allDisks;
      runnerSetup = lib.optionalString recordRuntimeLog "mkdir \"$out\"\n";
      runnerLogRedirect = lib.optionalString recordRuntimeLog " | tee \"$out/runtime.log\"";
      captureRunnerStatus =
        if recordRuntimeLog then
          ''
            runner_status=("''${PIPESTATUS[@]}")
            status="''${runner_status[0]}"
          ''
        else
          "status=$?";
      finishOutput =
        if recordRuntimeLog then
          ''
            [ "''${runner_status[1]}" -eq 0 ] || exit "''${runner_status[1]}"
            printf '%s\n' '::vm-test::closed' >> "$out/runtime.log"
            printf '%s\n' '::vm-test::closed'
          ''
        else
          "mkdir $out";
    in
    pkgs.runCommand "vm-test-${name}"
      {
        nativeBuildInputs = [ pkgs.nodejs ];
        passthru.ci.heavy = heavy;
        # Browser checks reuse the exact installed system, without building or
        # treating this Node-run check's result as browser execution evidence.
        passthru.runtimeAssets = {
          inherit initramfs cpus;
          disks = allDisks;
        };
      }
      ''
        ${lib.concatMapStringsSep "\n" (diskCopy: ''
          cp ${diskCopy.source} ${diskCopy.name}
          chmod u+w ${diskCopy.name}
        '') diskCopies}
        ${runnerSetup}set +e
        timeout --kill-after=5 300 node ${lib.escapeShellArgs nodeArguments} ${runner}/run-test.js \
          --cpus ${toString cpus} \
          ${lib.optionalString snapshotFirstDisk "--snapshot-first-disk"} \
          ${lib.optionalString readOnlyDisks "--readonly-disks"} \
          ${lib.optionalString vsockRoundtrip "--vsock-roundtrip"} \
          ${
            lib.optionalString (ninepExport != null) (
              "--ninep "
              + lib.escapeShellArgs [
                "${pkgs.diod}/sbin/diod"
                (toString ninepExport)
              ]
            )
          } \
          ${lib.optionalString ninepMemory "--ninep-memory"} \
          ${kernel}/dist/index.js \
          ${initramfs} \
          ${lib.concatMapStringsSep " " (diskCopy: diskCopy.name) diskCopies} \
          2>&1${runnerLogRedirect}
        ${captureRunnerStatus}
        set -e
        if [ "$status" -eq 124 ]; then
          echo "vm test failed: watchdog expired after 300 seconds" >&2
        fi
        [ "$status" -eq 0 ] || exit "$status"
        ${finishOutput}
      '';

  installedDisk =
    {
      name,
      init,
      contents ? [ ],
      files ? { },
      format ? "erofs",
    }:
    let
      fixtureName = lib.replaceStrings [ "_" ] [ "-" ] name;
      packages = map apk.packageFrom contents;
      repository = apk.mkRepository {
        name = "${fixtureName}-system";
        packages = lib.listToAttrs (
          map (p: {
            inherit (p) name;
            value = p;
          }) packages
        );
      };
      system = apk.mkSystem {
        name = "${fixtureName}-system";
        repositories = [ repository ];
        inherit packages;
        files = files // {
          "/init" = {
            source = init;
            mode = "0755";
          };
          "/vm-test-setup-dev-fd" = {
            source = ./setup-dev-fd.sh;
            mode = "0755";
          };
        };
      };
    in
    assert lib.assertMsg (contents != [ ]) "installedDisk requires at least one APK package";
    assert lib.assertMsg (!(files ? "/init")) "installedDisk files cannot define /init; use init";
    assert lib.assertMsg (
      !(files ? "/vm-test-setup-dev-fd")
    ) "installedDisk files cannot override /vm-test-setup-dev-fd";
    image.mkFilesystem {
      name = "${fixtureName}-system";
      root = system;
      inherit format;
    };

  installedTest =
    {
      name,
      init,
      contents ? [ ],
      files ? { },
      cpus ? 1,
      # Every installed test boots a VM and needs an isolated CI runner. The
      # aggregate builder can otherwise start enough guests concurrently to
      # starve unrelated tests and produce misleading failures.
      heavy ? true,
      disks ? [ ],
      recordRuntimeLog ? false,
    }:
    let
      fixtureName = lib.replaceStrings [ "_" ] [ "-" ] name;
      rootDisk = installedDisk {
        name = "${fixtureName}-test";
        inherit contents files init;
        # Package checks are disposable machines and commonly exercise writes
        # to /etc, /root, and /var. Keep production image policy separate from
        # this mutable test fixture.
        format = "ext4";
      };
    in
    bootInstalledSystem {
      inherit
        cpus
        heavy
        name
        recordRuntimeLog
        ;
      disks = [ rootDisk ] ++ disks;
      initramfs = image.bootInitramfs;
    };

  # Architecture bring-up needs to test a freshly bootstrapped executable
  # before that architecture has enough packages to construct an APK system.
  rawInitramfsTest =
    {
      name,
      init,
      contents ? [ ],
      files ? { },
      cpus ? 1,
      heavy ? true,
      disks ? [ ],
      snapshotFirstDisk ? false,
      readOnlyDisks ? false,
      nodeArguments ? [ ],
      vsockRoundtrip ? false,
      ninepExport ? null,
      ninepMemory ? false,
      initramfsCompression ? null,
      recordRuntimeLog ? false,
    }:
    assert lib.assertMsg (
      initramfsCompression == null || initramfsCompression == "zstd"
    ) "rawInitramfsTest only supports null or zstd initramfsCompression";
    let
      fixtureName = lib.replaceStrings [ "_" ] [ "-" ] name;
      archive = image.mkInitramfs {
        name = "${fixtureName}-initramfs";
        inherit init contents files;
      };
      compressedArchive =
        pkgs.runCommand "${fixtureName}-initramfs.cpio.zst" { nativeBuildInputs = [ pkgs.zstd ]; }
          ''
            zstd --quiet --threads=1 -3 --stdout ${archive} > "$out"
          '';
    in
    bootInstalledSystem {
      inherit
        cpus
        heavy
        name
        disks
        snapshotFirstDisk
        readOnlyDisks
        nodeArguments
        vsockRoundtrip
        ninepExport
        ninepMemory
        recordRuntimeLog
        ;
      # The existing runner reads this file unchanged. Decompression belongs
      # to the Linux initramfs path, never a build-host/runner preload step.
      initramfs = if initramfsCompression == null then archive else compressedArchive;
    };
in
{
  inherit
    installedDisk
    installedTest
    rawInitramfsTest
    runner
    ;
  recurseForDerivations = true;
}
