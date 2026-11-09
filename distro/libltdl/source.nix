# SPDX-License-Identifier: MIT
{ pkgs }:

pkgs.fetchurl {
  url = "https://ftp.gnu.org/gnu/libtool/libtool-2.5.4.tar.xz";
  hash = "sha256-+B9YYGZrC8fYS63e+mDRy5+m/OsjmMw7rKavqmAmZnU=";
}
