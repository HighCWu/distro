#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# shellcheck shell=bash
set -euo pipefail
exec @python@ @helper@ "$@"
