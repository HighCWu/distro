// SPDX-License-Identifier: MIT
import { test } from "@playwright/test";
import { checkPublicAgent } from "./agent-public-check.js";

test("runs native wasm64 HTTP through public agent networking", async ({ page }) => {
  await checkPublicAgent(page, true, true);
});
