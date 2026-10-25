import { expect, test } from "@playwright/test";
import { SEED, authHeaders, collectPageProblems } from "./helpers.js";

/**
 * Reading what the system holds: incidents and their triage, and the effective
 * configuration.
 *
 * These assert against the rows in database/seed.sql rather than waiting on the
 * detector, so they stay fast and deterministic; spec 04 drives a real
 * detection end to end.
 */
test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ request }) => {
  const response = await request.get(`/api/v1/events/${SEED.acknowledgedFireId}?include_frame=false`, {
    headers: authHeaders(),
  });
  test.skip(
    !response.ok(),
    "the seeded incidents are missing — load database/seed.sql to run the observability specs"
  );
});

test("the incident list renders the seeded incidents", async ({ page }) => {
  const problems = collectPageProblems(page);
  await page.goto("/events");

  await expect(page.getByRole("heading", { name: "Incidents", level: 5 })).toBeVisible();
  // 28 seeded incidents: a full first page, both kinds on it.
  await expect(page.getByTestId("incident-row")).toHaveCount(20);
  await expect(page.getByTestId("incident-row").filter({ hasText: "Fire" }).first()).toBeVisible();
  await expect(page.getByTestId("incident-row").filter({ hasText: "Smoke" }).first()).toBeVisible();

  expect(problems, problems.join("\n")).toEqual([]);
});

test("filtering by status narrows the list and lands in the URL", async ({ page }) => {
  await page.goto("/events");

  await page.getByLabel("Status").click();
  await page.getByRole("option", { name: "False Positive" }).click();

  // The filter is query-string state, so the filtered view is a real, linkable
  // URL that survives a reload — that is the point of putting it there.
  await expect(page).toHaveURL(/status=FALSE_POSITIVE/);
  const rows = page.getByTestId("incident-row");
  await expect(rows.first()).toBeVisible();
  for (const row of await rows.all()) {
    await expect(row).toContainText("False Positive");
  }

  await page.reload();
  await expect(rows.first()).toContainText("False Positive");
});

test("filtering by kind composes with the status filter", async ({ page }) => {
  await page.goto("/events?status=RESOLVED");

  await page.getByLabel("Kind").click();
  await page.getByRole("option", { name: "Smoke", exact: true }).click();

  await expect(page).toHaveURL(/status=RESOLVED/);
  await expect(page).toHaveURL(/kind=smoke/);

  const rows = page.getByTestId("incident-row");
  await expect(rows.first()).toBeVisible();
  for (const row of await rows.all()) {
    await expect(row).toContainText("Smoke");
    await expect(row).toContainText("Resolved");
  }
});

test("a filter combination with no matches says so rather than looking broken", async ({
  page,
}) => {
  // Every seeded incident has cleared, so none of them is still in view.
  await page.goto("/events?status=FALSE_POSITIVE&live=true");

  await expect(page.getByText("Nothing matches these filters")).toBeVisible();
  // Two of these on screen: one in the filter bar, one in the empty state.
  // Click the empty state's, which is the one an operator is looking at.
  await page.getByRole("button", { name: "Clear filters" }).last().click();
  await expect(page).toHaveURL(/\/events$/);
});

test("an incident opens to its detail, location, timeline and triage actions", async ({ page }) => {
  const problems = collectPageProblems(page);
  await page.goto(`/events/${SEED.acknowledgedFireId}`);

  await expect(
    page.getByRole("heading", { name: `Fire on ${SEED.acknowledgedFireCamera}`, level: 5 })
  ).toBeVisible();
  // The camera's building / floor / zone / area, joined the way the alert text reads.
  await expect(page.getByText(SEED.acknowledgedFirePlace).first()).toBeVisible();
  await expect(page.getByText("First seen", { exact: true })).toBeVisible();
  await expect(page.getByText("Confirmed, alert sent", { exact: true })).toBeVisible();
  await expect(page.getByText(SEED.acknowledgedFireAction)).toBeVisible();

  for (const action of ["Acknowledge", "Resolve", "False positive"]) {
    await expect(page.getByRole("button", { name: action, exact: true })).toBeVisible();
  }
  // It is already acknowledged, so that step is the one that is not offered.
  await expect(page.getByRole("button", { name: "Acknowledge", exact: true })).toBeDisabled();

  expect(problems, problems.join("\n")).toEqual([]);
});

test("resolving an incident records the action taken and disables the button", async ({
  page,
  request,
}) => {
  await page.goto(`/events/${SEED.acknowledgedFireId}`);

  const resolve = page.getByRole("button", { name: "Resolve", exact: true });
  await resolve.click();

  // Triage asks how the incident was handled before it changes anything, and
  // arrives with what was already recorded.
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Action taken")).toHaveValue(SEED.acknowledgedFireAction);
  await dialog.getByLabel("Action taken").fill("E2E: extinguished with CO2");
  await dialog.getByLabel("Notes").fill("Recorded by the e2e suite.");
  await dialog.getByRole("button", { name: "Resolve" }).click();
  await expect(dialog).toBeHidden();

  await expect(resolve).toBeDisabled({ timeout: 30_000 });
  await expect(page.getByText("E2E: extinguished with CO2")).toBeVisible();

  const response = await request.get(`/api/v1/events/${SEED.acknowledgedFireId}?include_frame=false`, {
    headers: authHeaders(),
  });
  const event = await response.json();
  expect(event.status).toBe("RESOLVED");
  expect(event.action_taken).toBe("E2E: extinguished with CO2");
  expect(event.resolved_at).toBeTruthy();
  expect(event.acknowledged_at).toBeTruthy();

  // Put it back, so a re-run starts from the state the seed describes. Not to
  // OPEN: that would raise the emergency dialog on every console.
  const restored = await request.patch(`/api/v1/events/${SEED.acknowledgedFireId}/status`, {
    headers: authHeaders(),
    data: { status: "ACKNOWLEDGED", action_taken: SEED.acknowledgedFireAction, description: "" },
  });
  expect(restored.ok()).toBeTruthy();
});

test("the system page reports workers and the config in force", async ({ page }) => {
  const problems = collectPageProblems(page);
  await page.goto("/system");

  await expect(page.getByRole("heading", { name: "Workers & config", level: 5 })).toBeVisible();
  // The value, not the panel caption that also says "connected" — the stat
  // card renders its value as an h4.
  await expect(page.getByRole("heading", { name: "Connected", level: 4 })).toBeVisible({
    timeout: 30_000,
  });

  // The tuning values are the first thing to check when an alert fires late, so
  // the groups must actually render rather than sit empty behind a failed call.
  for (const group of ["Detection", "Incidents", "Stream"]) {
    await expect(page.getByRole("heading", { name: group, exact: true })).toBeVisible();
  }
  await expect(page.getByText("fire confirm hits")).toBeVisible();
  await expect(page.getByText("fire cooldown s")).toBeVisible();

  expect(problems, problems.join("\n")).toEqual([]);
});
