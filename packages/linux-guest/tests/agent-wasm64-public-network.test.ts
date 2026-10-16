// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { hasTcpListener } from "./agent-wasm64-public-network.ts";

test("native network readiness requires the exact port and TCP LISTEN state", () => {
  const header = "  sl  local_address rem_address st tx_queue rx_queue";
  const row = " 0: 00000000:46A0 00000000:0000 0A 00000000:00000000";
  assert.equal(hasTcpListener(`${header}\n${row}\n`, 18080), true);
  assert.equal(hasTcpListener(row.replace("46A0", "46a0"), 18080), true);
  assert.equal(hasTcpListener(row, 18081), false);
  assert.equal(hasTcpListener(row.replace(" 0A ", " 01 "), 18080), false);
  assert.equal(
    hasTcpListener(
      row.replace("00000000:46A0", "00000000:0000").replace("00000000:0000 0A", "00000000:46A0 0A"),
      18080,
    ),
    false,
  );
  assert.equal(hasTcpListener(header, 18080), false);
  assert.equal(hasTcpListener("", 18080), false);
});
