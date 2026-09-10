import { expect, test } from "@playwright/test";

for (const colorScheme of ["light", "dark"] as const) {
  test(`home page in ${colorScheme} theme`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.goto("/");
    await page.evaluate(() => document.fonts.ready);

    const root = page.locator("html");
    if (colorScheme === "dark") {
      await expect(root).toHaveClass(/dark/);
    } else {
      await expect(root).not.toHaveClass(/dark/);
    }
    await expect(page.getByRole("heading", { level: 1, name: "Triplex" })).toBeVisible();
    const examples = page.locator('.triplex-home__snippet div[class*="language-"]');
    await expect(examples).toHaveCount(3);
    for (const example of await examples.all()) {
      await expect(example).toBeVisible();
    }
    await expect(page.getByRole("tab")).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Your application should be able to explain itself." }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Version the rules alongside the facts." }),
    ).toBeVisible();

    await expect(page).toHaveScreenshot(`home-${colorScheme}.png`, {
      animations: "disabled",
      fullPage: true,
    });
  });
}

test("home examples remain visible on mobile without page overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const examples = page.locator('.triplex-home__snippet div[class*="language-"]');
  await expect(examples).toHaveCount(3);
  for (const example of await examples.all()) {
    await expect(example).toBeVisible();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
