# SPDX-License-Identifier: MIT
{
  python,
  stdenv-dynamic-loader,
  sdk-dynamic-loader,
}:
let
  package = python.override {
    stdenv = stdenv-dynamic-loader;
    llvm-toolchain = sdk-dynamic-loader.compiler;
  };
in
package.overrideAttrs (old: {
  pname = "python-dynamic";

  postBuild = (old.postBuild or "") + ''
    # These are CPython's ordinary Linux configure results. Keep its stdlib
    # modules static while requiring a real target dlopen link probe for
    # third-party shared extensions.
    grep -qx '#define HAVE_DLOPEN 1' pyconfig.h
    grep -qx '#define HAVE_DYNAMIC_LOADING 1' pyconfig.h
    grep -qx 'DYNLOADFILE= dynload_shlib.o' Makefile
    grep -Eq '^CCSHARED=[[:space:]]+-fPIC$' Makefile
    grep -Eq '^LDSHARED=[[:space:]]+[$][(]CC[)] -shared([[:space:]]|$)' Makefile
    grep -Eq '^LINKFORSHARED=[[:space:]]+-Xlinker -export-dynamic$' Makefile
    grep -Fqx 'LINK_PYTHON_OBJS=$(LIBRARY_OBJS)' Makefile
  '';

  postInstall = (old.postInstall or "") + ''
    notices=$out/share/licenses/python
    mkdir -p "$notices"

    # Keep the notices for code supplied by the dynamic SDK and its libc next
    # to CPython's original source and dependency licenses.
    install -m644 ${sdk-dynamic-loader.buildMaterials}/licenses/SDK-MIT.txt \
      "$notices/SDK-MIT.txt"
    install -m644 ${sdk-dynamic-loader.buildMaterials}/licenses/musl-COPYRIGHT \
      "$notices/musl-COPYRIGHT"
    install -m644 ${sdk-dynamic-loader.compiler.licenseSource}/compiler-rt/LICENSE.TXT \
      "$notices/compiler-rt-LICENSE.TXT"

    # CPython's original buildMaterials already contains pyconfig.h, Makefile,
    # config.log, and the actual compiler identity. Add this thin wrapper
    # recipe and the dynamic SDK source/license materials used for the build.
    install -m644 ${./package.nix} "$buildMaterials/python-dynamic.package.nix"
    ln -s ${sdk-dynamic-loader.buildMaterials} "$buildMaterials/dynamic-sdk"
  '';
})
