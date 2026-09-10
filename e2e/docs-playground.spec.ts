import { expect, test } from "@playwright/test";

test("guided changes update query results and retractions preserve the journal", async ({
  page,
}) => {
  await page.goto("/playground");
  const result = page.getByLabel("Query results");
  await expect(result).toContainText("Mina Patel");
  await expect(page.getByText("5 visible facts")).toBeVisible();

  await page.getByLabel("Quiz score").fill("87");
  await page.getByRole("button", { name: "Grade Mina’s quiz" }).click();
  await expect(page.getByText("6 visible facts")).toBeVisible();
  await expect(result).toContainText("No submissions need grading");
  await expect(page.getByRole("row").filter({ hasText: ":submission/score" })).toContainText("87");
  await expect(page.getByRole("status").filter({ hasText: "Commit #2" })).toContainText(
    "1 fact added, 0 retracted.",
  );

  await page.getByRole("button", { name: "Retract this change" }).click();
  await expect(result).toContainText("Mina Patel");
  await expect(page.getByText("5 visible facts")).toBeVisible();
  await expect(page.getByText("3 commits")).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: ":submission/score" })).toHaveCount(0);

  // Repeating the guided action uses a fresh command ID without resetting the store.
  await page.getByRole("button", { name: "Grade Mina’s quiz" }).click();
  await expect(result).toContainText("No submissions need grading");
  await expect(page.getByText("4 commits")).toBeVisible();
  await page.getByRole("button", { name: "Reset database" }).click();
  await expect(result).toContainText("Mina Patel");
  await expect(page.getByText("1 commit", { exact: true })).toBeVisible();
});

test("domains offer working guided examples, including a blank database", async ({ page }) => {
  await page.goto("/playground");
  await expect(page.getByText("5 visible facts")).toBeVisible();
  const result = page.getByLabel("Query results");
  await page.getByLabel("Domain").selectOption("compliance");
  await expect(page.getByText("4 visible facts")).toBeVisible();
  await expect(result).toContainText("worker:maria");
  await expect(result).toContainText("site:harbor");
  await page.getByRole("button", { name: "Record Maria’s training" }).click();
  await expect(result).toContainText("No placements are missing training");
  await expect(page.getByText("6 visible facts")).toBeVisible();
  await page.getByRole("button", { name: "Retract this change" }).click();
  await expect(result).toContainText("Maria");
  await expect(page.getByText("4 visible facts")).toBeVisible();

  await page.getByLabel("Domain").selectOption("blank");
  await expect(page.getByText("0 visible facts")).toBeVisible();
  await expect(page.getByText("No transactions yet.")).toBeVisible();
  await page.getByLabel("Example name").fill("Hello Triplex");
  await page.getByRole("button", { name: "Add your first fact" }).click();
  await expect(result).toContainText("Hello Triplex");
  await page.getByRole("button", { name: "Retract this change" }).click();
  await expect(result).toContainText("No example names yet");
});

test("advanced editors support custom queries and recover from errors", async ({ page }) => {
  await page.goto("/playground");
  await expect(page.getByText("5 visible facts")).toBeVisible();
  await page
    .locator("summary")
    .filter({ hasText: "Go further: edit queries and transactions" })
    .click();
  const query = page.getByLabel("Datalog query JSON");
  await query.fill("invalid JSON");
  await page.getByRole("button", { name: "Run query", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByLabel("Query results")).toContainText("Query failed");
  await query.fill(
    JSON.stringify({ find: ["?name"], where: [["?student", ":person/name", "?name"]] }),
  );
  await page.getByRole("button", { name: "Run query", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Your query results" })).toBeVisible();
  await expect(page.getByLabel("Query results")).toContainText("Mina Patel");
  await page.getByRole("button", { name: "Apply transaction" }).click();
  await expect(page.getByText("6 visible facts")).toBeVisible();
  await page.getByRole("button", { name: "Apply transaction" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByText("2 commits")).toBeVisible();
  await page.getByRole("button", { name: "Restore sample query" }).click();
  await expect(page.getByLabel("Query results")).toContainText("No submissions need grading");
});

test("playground fits mobile with guided changes and editors open", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/playground");
  await expect(page.getByText("5 visible facts")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByRole("button", { name: "Grade Mina’s quiz" }).click();
  await expect(page.getByText("6 visible facts")).toBeVisible();
  await page
    .locator("summary")
    .filter({ hasText: "Go further: edit queries and transactions" })
    .click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expect(page.getByLabel("Datalog query JSON")).toBeVisible();
});
