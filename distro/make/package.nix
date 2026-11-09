{
  pkgs,
  stdenv,
  src ? pkgs.fetchzip {
    url = "mirror://gnu/make/make-4.4.1.tar.gz";
    hash = "sha256-+Cg7R8wougcWcFf6u5B3lVX6RRgMRYZ1CD+e21URP5A=";
  },
  busybox,
  vm-test,
}:

stdenv.mkDerivation (finalAttrs: {
  pname = "make";
  version = "4.4.1";
  inherit src;
  passthru.apk = {
    depends = [ "busybox" ];
    replaces = [ "busybox" ];
  };

  # This default SDK build runs recipes through posix_spawn (clone+execve).
  # The optional continuation fork profile has a separate release boundary.
  # GNU make already has a full
  # posix_spawn job path (src/job.c, USE_POSIX_SPAWN) used on macOS. configure
  # defines USE_POSIX_SPAWN unless one of user/support/synchronous is exactly
  # "no": header spawn.h and func posix_spawn both detect against musl, and the
  # synchronous-failure probe is a run test that yields "no (cross-compiling)"
  # -- which is not the literal "no" the gate rejects -- so the spawn path is
  # selected without a patch. make_cv_synchronous_posix_spawn=yes states the
  # truth for musl (posix_spawn reports exec failure synchronously through its
  # internal errno pipe) and pins the answer deterministically instead of
  # leaning on the cross-compile default string.
  configureFlags = [
    "--disable-nls"
    "--without-guile"
    # This static SDK's dlopen entry is a stub. Configure detects that symbol
    # at link time and would enable MAKE_LOAD without an execution provider.
    # The optional make-dynamic product supplies the dynamic SDK for 'load'.
    "--disable-load"
    "make_cv_synchronous_posix_spawn=yes"
  ];

  passthru.checks = {
    functionality = vm-test.installedTest {
      name = "make-functionality";
      init = ./functionality-test.sh;
      contents = [
        busybox
        finalAttrs.finalPackage
      ];
    };
  };
})
