{
  pkgs,
  stdenv,
  lib,
  debug,
  linux,
  musl,
  llvm-runtimes,
  platform,
  src ? pkgs.fetchFromGitHub {
    owner = "tombl";
    repo = "busybox";
    rev = "4ad91c87e7efeff15628bea7240b6055b2737644";
    hash = "sha256-IwdmKbP2LPrw011n3DmsX75siuBlzc358Zk+IulwaVw=";
  },
  vm-test,
}:

let
  identity = value: builtins.baseNameOf "${value}";
  buildMetadata = pkgs.writeText "busybox-build.json" (
    builtins.toJSON {
      schemaVersion = 1;
      addressBits = platform.addressBits;
      inherit debug;
      sourceIdentity = identity src;
      muslSourceIdentity = identity musl.src;
      runtimeSourceIdentity = identity llvm-runtimes.src;
      compilerIdentity = identity stdenv.cc;
      linuxHeadersIdentity = identity linux.headers;
      scope = "Selected BusyBox source and build materials; not a full dependency inventory or offline rebuild environment";
    }
  );
in
stdenv.mkDerivation (finalAttrs: {
  pname = "busybox";
  version = "1.37.0";
  inherit src;
  outputs = [
    "out"
    "buildMaterials"
  ];
  meta.license = lib.licenses.gpl2Only;
  meta.outputsToInstall = [ "out" ];

  # busybox builds host tools with HOSTCC during the target build.
  depsBuildBuild = [ pkgs.stdenv.cc ];
  nativeBuildInputs = [ pkgs.nodejs ];

  configurePhase = ''
    runHook preConfigure

    config() {
      sed -i "/CONFIG_$1=/d" .config
      sed -i "/CONFIG_$1 is not set/d" .config
      case $2 in
        y|n) echo "CONFIG_$1=$2" >> .config ;;
        *) echo "CONFIG_$1=\"$2\"" >> .config ;;
      esac
    }

    make -j$NIX_BUILD_CORES defconfig
    config STATIC y
    config NOMMU y
    config STATIC_LIBGCC n
    config CROSS_COMPILER_PREFIX llvm-
    config EXTRA_CFLAGS '-I${linux.headers}/include ${lib.optionalString debug "-g"}'
    config EXTRA_LDLIBS c

    config MOUNT y
    config SWITCH_ROOT y
    config CHROOT y
    config HUSH y
    config SH_IS_ASH n
    config SH_IS_HUSH y
    config SH_IS_NONE n
    config BASH_IS_ASH n
    config BASH_IS_HUSH n
    config BASH_IS_NONE y

    config BOOTCHARTD n
    config CONSPY n
    config CROND y
    config CRONTAB y
    config DEVMEM n
    config FBSPLASH n
    config FTPD y
    config FEATURE_FTPD_AUTHENTICATION n
    config HDPARM n
    config HEXEDIT n
    config HTTPD y
    config IFDOWN y
    config IFUP y
    config INETD n
    config NC y
    config NSENTER n
    config SCRIPT y
    config START_STOP_DAEMON y
    config SWAPOFF n
    config SWAPON n
    # Linux 7.1 removed the CBQ qdisc UAPI which this BusyBox release's tc
    # applet still requires. None of our guest networking uses that applet.
    config TC n
    config TCPSVD y
    config TELNETD n
    config TIME y
    config TS y
    config UDPSVD y
    config WGET y

    config SENDMAIL n
    config REFORMIME n
    config MAKEMIME n
    config POPMAILDIR n

    config INIT n
    config LINUXRC n

    config RUNSV n
    config RUNSVDIR n
    config SVLOGD n

    config HUSH_TICK y

    config HWCLOCK n
    config RTCWAKE n

    make -j$NIX_BUILD_CORES oldconfig

    runHook postConfigure
  '';

  # busybox partial-links object files with `$CC -r`, where executable
  # flags like --export-table are invalid, so the stdenv default is opted
  # out of and the flags applied to the final binary only.
  linkerFlags = lib.concatMapStringsSep " " (flag: "-Wl,${flag}") platform.linkerFlags;

  buildPhase = ''
    runHook preBuild
    unset NIX_CFLAGS_LINK
    make -j$NIX_BUILD_CORES CC="$CC" HOSTCC="$CC_FOR_BUILD" CFLAGS_busybox="$linkerFlags" ${lib.optionalString debug "SKIP_STRIP=y"}
    node ${./check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      busybox ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    make -j$NIX_BUILD_CORES CC="$CC" HOSTCC="$CC_FOR_BUILD" CFLAGS_busybox="$linkerFlags" CONFIG_PREFIX=$out install
    notices=$out/share/licenses/busybox
    mkdir -p "$notices"
    cp LICENSE "$notices/LICENSE"
    cp ${musl.src}/COPYRIGHT "$notices/musl-COPYRIGHT"
    cp ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT "$notices/compiler-rt-LICENSE.TXT"
    cp ${./notices.md} "$notices/README.md"
    bash ${./build-materials.sh} "$PWD" "$buildMaterials" ${./package.nix} \
      ${buildMetadata} ${./source-bundle.README.md}
    cp ${./check-binary.mjs} "$buildMaterials/check-binary.mjs"
    cp ${../../packages/kernel/src/wasm_binary.ts} "$buildMaterials/wasm_binary.ts"
    cp ${./notices.md} "$buildMaterials/notices.md"
    (cd "$buildMaterials" && sha256sum check-binary.mjs wasm_binary.ts notices.md >> SHA256SUMS)
    runHook postInstall
  '';

  passthru.sourceBundle = import ./source-bundle.nix {
    inherit pkgs;
    busybox = finalAttrs.finalPackage;
    addressBits = platform.addressBits;
    maximumMemoryBytes = platform.maximumMemoryBytes;
  };

  passthru.checks =
    let
      check =
        name: init:
        vm-test.installedTest {
          name = "busybox-${name}";
          inherit init;
          contents = [ finalAttrs.finalPackage ];
        };
    in
    {
      source-bundle = finalAttrs.finalPackage.sourceBundle.check;
      source-bundle-host =
        pkgs.runCommand "busybox-source-bundle-host-check"
          {
            nativeBuildInputs = [
              pkgs.nodejs
              pkgs.bash
              pkgs.gnutar
              pkgs.gzip
              pkgs.coreutils
              pkgs.gnused
            ];
          }
          ''
            node --test ${./.}/source-bundle.test.js
            touch $out
          '';
      smoke = check "smoke" ./smoke-test.sh;
      processes = check "processes" ./process-test.sh;
      networking = check "networking" ./network-test.sh;
    };
})
