import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    let state = 0x5eed1234;
    Object.defineProperty(globalThis.crypto, "getRandomValues", {
      configurable: true,
      value: <T extends ArrayBufferView | null>(array: T): T => {
        if (array === null) throw new TypeError("Expected an integer array");
        const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
        for (let index = 0; index < bytes.length; index += 1) {
          state ^= state << 13;
          state ^= state >>> 17;
          state ^= state << 5;
          bytes[index] = state & 0xff;
        }
        return array;
      },
    });
  });
  await page.clock.setFixedTime(new Date("2026-01-15T12:00:00.000Z"));
  await page.goto("http://127.0.0.1:4174/");
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "See the database think" }),
  ).toBeVisible();
  await expect(page.getByText("Ready", { exact: true })).toBeVisible();
});

test("dashboard overview", async ({ page }) => {
  await expect(page.getByText("memory://demo-learning", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Recent transactions" })).toBeVisible();

  await expect(page).toHaveScreenshot("dashboard-overview.png", {
    animations: "disabled",
    fullPage: true,
  });
});

test("temporal basis controls", async ({ page }) => {
  await page.getByRole("button", { name: /valid now.*recorded latest/ }).click();
  await expect(page.getByRole("complementary", { name: "Temporal basis" })).toBeVisible();
  await expect(page.getByText("Read the database as of…", { exact: true })).toBeVisible();

  await expect(page).toHaveScreenshot("dashboard-temporal-basis.png", {
    animations: "disabled",
    fullPage: true,
  });
});
