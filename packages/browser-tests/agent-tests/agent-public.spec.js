// SPDX-License-Identifier: MIT
import { test } from "@playwright/test";
import { checkPublicAgent } from "./agent-public-check.js";

test("boots native wasm64 through public guestAgent image selection", async ({ page }) => {
  await checkPublicAgent(page);
});
