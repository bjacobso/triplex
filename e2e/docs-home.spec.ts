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
    await expect(page.locator(".triplex-home__code")).toBeVisible();

    await expect(page).toHaveScreenshot(`home-${colorScheme}.png`, {
      animations: "disabled",
      fullPage: true,
    });
  });
}
