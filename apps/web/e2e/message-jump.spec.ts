import { expect, test } from "@playwright/test";
import { activeBotId, completeOnboarding, rpc, signup } from "./helpers";

test("a ?m= deep link jumps while the thread is streaming", async ({ page }) => {
  const stamp = Date.now();
  await signup(page, `jump-${stamp}@rakazo.test`, "password12", "Jump Tester");
  await completeOnboarding(page);

  const botId = activeBotId(page);
  const transcript = page.getByTestId("transcript");
  const composer = page.getByRole("combobox", { name: /Message/ });

  const targetText = `jump-target-${stamp}`;
  await composer.fill(targetText);
  await composer.press("Enter");
  const targetRow = transcript
    .locator("[data-message-id]")
    .filter({ has: page.getByTestId("message-user-bubble") })
    .filter({ hasText: targetText })
    .first();
  await expect(targetRow).toBeVisible({ timeout: 20_000 });
  const messageId = await targetRow.getAttribute("data-message-id");
  if (!messageId) throw new Error("missing data-message-id");

  // Flood the thread: every send steers a run, so SSE events re-render the
  // shell continuously. A deep link arriving mid-flood must still land —
  // previously the navigation sat in a starved React transition and the jump
  // never ran while the URL already showed ?m=.
  let flooding = true;
  let sent = 0;
  const flood = Promise.all(
    Array.from({ length: 3 }, async (_, lane) => {
      while (flooding) {
        const i = sent++;
        await rpc(page, "threads/send", {
          botId,
          text: `jump-flood-${stamp}-${lane}-${i}`,
          clientNonce: `jf-${stamp}-${lane}-${i}`,
        }).catch(() => {});
      }
    }),
  );
  try {
    await page.waitForTimeout(3_000);
    const sentAtPush = sent;

    const aroundJump = page.waitForRequest(
      (request) =>
        request.url().includes("/rpc/threads/messages") &&
        (request.postData() ?? "").includes('"around"'),
      { timeout: 15_000 },
    );
    await page.evaluate((id) => {
      history.pushState({}, "", `?m=${id}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, messageId);
    await expect(page).toHaveURL(new RegExp(`m=${messageId}`));

    // The around-page fetch is the jump hitting the wire; sends continuing in
    // the meantime prove the thread was still churning when it landed.
    await aroundJump;
    expect(sent).toBeGreaterThan(sentAtPush);

    // The around page is committed — the target row exists — and the one-shot
    // param is stripped so a refresh does not re-jump.
    await expect(page.locator(`[data-message-id="${messageId}"]`)).toBeAttached({
      timeout: 20_000,
    });
    await expect(page).not.toHaveURL(/[?&]m=/, { timeout: 20_000 });
  } finally {
    flooding = false;
    await flood;
    await rpc(page, "threads/stop", { botId }).catch(() => {});
  }
});
