import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

const fixture = "/e2e/fixtures/markdown-table.html";

test("markdown tables render as an interactive card", async ({ page }, testInfo) => {
  await page.goto(fixture);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);

  const card = page.getByTestId("table-card");
  await expect(card).toBeVisible();
  await expect(card.locator("tbody tr")).toHaveCount(10);
  await expect(card.getByRole("button", { name: "Copy rows" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Download CSV" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Expand table" })).toBeVisible();

  // Numeric sort: desc puts qty 12 first; lexicographic would put 9 first.
  // thead th nth(0) is the row-number gutter, so Qty sits at index 2.
  const qtyHeader = card.locator("thead th").nth(2);
  await card.getByRole("button", { name: "Sort by Qty" }).click();
  await expect(qtyHeader).toHaveAttribute("aria-sort", "ascending");
  await expect(card.locator("tbody tr").first()).toContainText("item-01");
  await card.getByRole("button", { name: "Sort by Qty" }).click();
  await expect(qtyHeader).toHaveAttribute("aria-sort", "descending");
  await expect(card.locator("tbody tr").first()).toContainText("item-12");
  // Third click clears the sort and restores source order.
  await card.getByRole("button", { name: "Sort by Qty" }).click();
  await expect(qtyHeader).not.toHaveAttribute("aria-sort", /./);
  await expect(card.locator("tbody tr").first()).toContainText("item-01");

  // Pagination past the page size.
  await expect(card.getByText("1–10 of 12 rows")).toBeVisible();
  await card.getByRole("button", { name: "Next page" }).click();
  await expect(card.getByText("11–12 of 12 rows")).toBeVisible();
  await expect(card.locator("tbody tr")).toHaveCount(2);
  await card.getByRole("button", { name: "Previous page" }).click();
  await expect(card.locator("tbody tr")).toHaveCount(10);

  // Copy as TSV.
  await card.getByRole("button", { name: "Copy rows" }).click();
  await expect
    .poll(async () => page.evaluate(() => navigator.clipboard.readText()))
    .toContain("Item\tQty\nitem-01");

  // CSV download.
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    card.getByRole("button", { name: "Download CSV" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("table.csv");

  // Fullscreen dialog re-renders the table; Escape closes it.
  await card.getByRole("button", { name: "Expand table" }).click();
  const dialog = page.getByRole("dialog", { name: "Table" });
  await expect(dialog.locator("tbody tr")).toHaveCount(10);
  // Focus moves into the portaled dialog, and cells keep their card styling
  // (the portal sits outside .rk-chat-markdown).
  await expect(dialog).toBeFocused();
  const cellPadding = await dialog
    .locator("tbody td")
    .nth(1)
    .evaluate((el) => getComputedStyle(el).padding);
  expect(cellPadding).not.toBe("0px");
  await captureScreenshot(page, testInfo, "markdown-table-card");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Expand table" })).toBeFocused();
});

test("small tables skip pagination", async ({ page }) => {
  await page.goto(`${fixture}?rows=3`);
  const card = page.getByTestId("table-card");
  await expect(card).toBeVisible();
  await expect(card.locator("tbody tr")).toHaveCount(3);
  await expect(card.getByText("3 rows")).toBeVisible();
  await expect(card.getByRole("button", { name: "Next page" })).toHaveCount(0);
});

test("bot replies render markdown tables as cards", async ({ page }) => {
  const stamp = Date.now();
  await signup(page, `table-card-${stamp}@rakazo.test`, "password12", "Table Card");
  await completeOnboarding(page);

  const composer = page.getByRole("combobox", { name: /^Message/ });
  await expect(composer).toBeVisible();
  await composer.fill("show this table:\n\n| Item | Qty |\n| --- | --- |\n| a | 2 |\n| b | 1 |");
  await composer.press("Enter");

  // The scripted runtime echoes the prompt back; the card must appear in a bot bubble.
  const botCard = page.getByTestId("message-bot-bubble").last().getByTestId("table-card");
  await expect(botCard).toBeVisible({ timeout: 20_000 });
  await expect(botCard.locator("tbody tr")).toHaveCount(2);
  await expect(botCard).toContainText("Item");
});
