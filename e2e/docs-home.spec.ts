import { expect, test } from "@playwright/test";

for (const colorScheme of ["light", "dark"] as const) {
  test(`home page in ${colorScheme} theme`, async ({ page }) => {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
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

    // The six client steps render every region of the checked homepage program.
    await expect(content).toContainText("npm install @triplex-build/triplex effect");
    await expect(page.locator(".th-steps .th-step")).toHaveCount(6);
    const examples = page.locator('.th-steps .th-window div[class*="language-"]');
    await expect(examples).toHaveCount(7);
    for (const example of await examples.all()) {
      await expect(example).toBeVisible();
    }
    await expect(content).toContainText("db.command");
    await expect(content).toContainText("db.asOf");
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
  const examples = page.locator('.th-steps .th-window div[class*="language-"]');
  await expect(examples).toHaveCount(7);
  for (const example of await examples.all()) {
    await expect(example).toBeVisible();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("hero replays the checked program from model to time travel", async ({ page }) => {
  await page.goto("/");
  const hero = page.locator(".hero-replay");
  const step = (name: string) =>
    hero.getByRole("group", { name: "Walkthrough steps" }).getByRole("button", { name });
  // Autoplay starts at the model; the step buttons jump anywhere.
  await expect(step("1 Model")).toHaveAttribute("aria-pressed", "true");
  await expect(hero).toContainText(":worker/name");
  await step("3 Move").click();
  await expect(hero.locator("tbody tr")).toHaveCount(4);
  await expect(hero).toContainText("Mar 2 – Jun 1");
  await step("4 Correct").click();
  await expect(hero.locator("tbody tr.is-retracted")).toHaveCount(2);
  await expect(hero).toContainText("Maria Rivera");
  await step("5 Ask").click();
  await expect(hero).toContainText("what Dana knew");
  await expect(hero).toContainText("site ← tx 3 · user:dana · workers-v1");
});

test("hero shows the full story without motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const hero = page.locator(".hero-replay");
  await expect(hero.getByRole("button", { name: "5 Ask" })).toHaveAttribute("aria-pressed", "true");
  await expect(hero.getByRole("button", { name: "Play the walkthrough" })).toBeVisible();
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
