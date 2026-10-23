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
    await expect(
      page.getByRole("heading", { level: 1, name: "The database that remembers why." }),
    ).toBeVisible();
    const content = page.locator("#VPContent");
    await expect(content.getByRole("link", { name: /Get started/ })).toHaveAttribute(
      "href",
      "/getting-started",
    );
    await expect(content.getByRole("link", { name: "Modeling guide for agents" })).toHaveAttribute(
      "href",
      "/agents",
    );
    await expect(
      page.getByRole("heading", { name: "Reading this as a coding agent?" }),
    ).toBeVisible();

    // The stack map, journal table, and every step are rendered from verified scenario outputs.
    const stack = page.locator(".stack-map");
    await expect(stack.getByRole("link")).toHaveCount(6);
    await expect(stack).toContainText(/\d+ lines from schema to REST API/);
    const timeline = page.locator(".triplex-home__timeline table");
    await expect(timeline.locator("tbody tr")).toHaveCount(6);
    await expect(timeline).toContainText("create:placement:maria-harbor");
    const examples = page.locator('.triplex-home__snippet div[class*="language-"]');
    await expect(examples).toHaveCount(11);
    for (const example of await examples.all()) {
      await expect(example).toBeVisible();
    }
    await expect(content).toContainText('"trainedAsKnownThen": true');
    await expect(content).toContainText('"governedBy": "hr-2026.1"');
    await expect(page.getByRole("tab")).toHaveCount(0);

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
  await expect(examples).toHaveCount(11);
  for (const example of await examples.all()) {
    await expect(example).toBeVisible();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("decision receipt preserves its rules while switching recorded knowledge", async ({
  page,
}) => {
  await page.goto("/");
  const receipt = page.locator(".decision-trace");
  const original = receipt.getByRole("button", { name: "At the decision", exact: true });
  const corrected = receipt.getByRole("button", { name: "After the correction", exact: true });
  await expect(original).toHaveAttribute("aria-pressed", "true");
  await expect(receipt.locator(".decision-trace__result strong")).toHaveText("true");
  await corrected.click();
  await expect(corrected).toHaveAttribute("aria-pressed", "true");
  await expect(original).toHaveAttribute("aria-pressed", "false");
  await expect(receipt.locator(".decision-trace__result strong")).toHaveText("false");
  await expect(receipt).toContainText("The corrected certificate starts March 5.");
  await expect(receipt.locator(".decision-trace__fields")).toContainText("hr-2026.1");
  await original.click();
  await expect(receipt.locator(".decision-trace__result strong")).toHaveText("true");
});

test("agent-readable documentation is served as plain text", async ({ request }) => {
  const index = await request.get("/llms.txt");
  expect(index.ok()).toBe(true);
  expect(index.headers()["content-type"]).toContain("text/plain");
  const body = await index.text();
  expect(body).toMatch(/^# Triplex\n\n> The database that remembers why/);
  expect(body).toContain("(https://triplex.build/agents.md)");

  const guide = await request.get("/agents.md");
  expect(guide.headers()["content-type"]).toContain("text/markdown");
  const markdown = await guide.text();
  expect(markdown).toMatch(/^# Modeling a back-office domain/);
  // Code imports are resolved into fenced code rather than left as VitePress directives.
  expect(markdown).toContain("commandId: `create:${placement}`");
  expect(markdown).not.toContain("<<<");

  const full = await request.get("/llms-full.txt");
  expect(await full.text()).toContain("# Troubleshooting and FAQ");
});
