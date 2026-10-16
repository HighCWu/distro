# SPDX-License-Identifier: MIT
{
  bytes,
  pkgs,
  sdk-wasm64,
}:

pkgs.runCommand "linux-agent-abi-wasm64"
  {
    passthru.ci.heavy = true;
    nativeBuildInputs = [ pkgs.nodejs ];
  }
  ''
    mkdir -p node_modules/@lowland/bytes $out
    cp -r ${bytes}/. node_modules/@lowland/bytes/
    cp ${../../packages/linux-guest/src/abi.ts} abi.ts
    cp ${../../packages/linux-guest/src/abi-wasm64.ts} abi-wasm64.ts
    node ${./gen-abi-check.ts} ./abi-wasm64.ts > abi-check.c
    ${sdk-wasm64}/bin/wasm-linux-cc -Wall -Wextra -Werror \
      -c abi-check.c -o abi-check.o
    # Compile the executor too, without claiming a runnable wasm64 agent image
    # or compatibility with the current wasm32 host session implementation.
    ${sdk-wasm64}/bin/wasm-linux-cc -Wall -Wextra -Werror \
      -c ${./agent.c} -o agent.o
    cp abi-check.c abi-check.o agent.o $out/
  ''
