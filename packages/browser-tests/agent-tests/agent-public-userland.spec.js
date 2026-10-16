// SPDX-License-Identifier: MIT
import { test } from "@playwright/test";
import { checkPublicAgent } from "./agent-public-check.js";

test("runs native wasm64 shell through public guestAgent image selection", async ({ page }) => {
  await checkPublicAgent(page, true);
});
