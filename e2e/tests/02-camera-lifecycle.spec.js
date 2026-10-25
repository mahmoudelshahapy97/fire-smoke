import { expect, test } from "@playwright/test";
import {
  CAMERA_BUILDING,
  CAMERA_FLOOR,
  CAMERA_NAME,
  CAMERA_PLACE,
  CAMERA_SOURCE,
  CAMERA_ZONE,
  authHeaders,
  collectPageProblems,
  findCamera,
} from "./helpers.js";

/**
 * Registering a camera through the form, and what the console shows about it
 * afterwards. The assertions check both what the page renders and what the API
 * actually stored.
 *
 * The camera reads fire1.mp4, which is on fire for most of its loop. It is
 * registered alerting on smoke only (which that clip never shows), so no
 * emergency dialog pops up over the following specs; 04 turns fire on.
 */
test.describe.configure({ mode: "serial" });

test("the form refuses to submit without the required fields", async ({ page }) => {
  await page.goto("/cameras/new");
  await expect(
    page.getByRole("heading", { name: "Register a camera", level: 5 })
  ).toBeVisible();

  await page.getByRole("button", { name: "Register camera" }).click();

  // Client-side validation, not a round trip: the API would answer 422 with a
  // message an operator cannot act on next to the field it belongs to.
  await expect(page.getByText("Required").first()).toBeVisible();
  await expect(page).toHaveURL(/\/cameras\/new$/);
});

test("more confirmations than the window holds is rejected", async ({ page }) => {
  await page.goto("/cameras/new");

  await page.getByLabel("Name").fill("Invalid thresholds");
  await page.getByLabel("RTSP URL").fill(CAMERA_SOURCE);
  await page.getByLabel("Confirm after").fill("6");
  await page.getByLabel("Out of the last").fill("5");

  await page.getByRole("button", { name: "Register camera" }).click();

  // 6 sightings out of 5 checks can never happen: the camera would never alert.
  await expect(page.getByText("Cannot exceed the window")).toBeVisible();
  await expect(page).toHaveURL(/\/cameras\/new$/);
});

test("a camera alerting on neither fire nor smoke is rejected", async ({ page }) => {
  await page.goto("/cameras/new");
  await page.getByLabel("Name").fill("Alerts nothing");
  await page.getByLabel("RTSP URL").fill(CAMERA_SOURCE);
  await page.getByLabel("Alert on fire").uncheck();
  await page.getByLabel("Alert on smoke").uncheck();
  await page.getByRole("button", { name: "Register camera" }).click();
  await expect(page.getByText("Alert on at least one of fire and smoke")).toBeVisible();
});

test("a camera registered through the form is persisted and opened", async ({ page, request }) => {
  const problems = collectPageProblems(page);
  await page.goto("/cameras/new");

  await page.getByLabel("Name").fill(CAMERA_NAME);
  await page.getByLabel("RTSP URL").fill(CAMERA_SOURCE);
  await page.getByLabel("Building").fill(CAMERA_BUILDING);
  await page.getByLabel("Floor").fill(CAMERA_FLOOR);
  await page.getByLabel("Zone").fill(CAMERA_ZONE);
  await page.getByLabel("Fire confidence").fill("0.6");
  await page.getByLabel("Alert on fire").uncheck();

  await page.getByRole("button", { name: "Register camera" }).click();

  // Lands on the new camera's detail page, which means the response carried the
  // generated camera_id back.
  await expect(page).toHaveURL(/\/cameras\/[0-9a-f-]{36}$/, { timeout: 45_000 });
  await expect(page.getByRole("heading", { name: CAMERA_NAME, level: 5 })).toBeVisible();

  const stored = await findCamera(request);
  expect(stored, "camera was not persisted").not.toBeNull();
  expect(stored.rtsp_url).toBe(CAMERA_SOURCE);
  expect(stored.building).toBe(CAMERA_BUILDING);
  expect(stored.floor_level).toBe(CAMERA_FLOOR);
  expect(stored.zone).toBe(CAMERA_ZONE);
  expect(stored.enabled).toBe(true);

  // settings is jsonb, which asyncpg hands back as a string. A blank override
  // must be absent rather than zero — zero is a real, and very wrong, value.
  const settings =
    typeof stored.settings === "string" ? JSON.parse(stored.settings) : stored.settings;
  expect(settings.fire_confidence).toBe(0.6);
  expect(settings.kinds).toEqual(["smoke"]);
  expect(settings).not.toHaveProperty("confirm_hits");

  expect(problems, problems.join("\n")).toEqual([]);
});

test("a duplicate name is refused with the backend's message", async ({ page }) => {
  await page.goto("/cameras/new");

  await page.getByLabel("Name").fill(CAMERA_NAME);
  await page.getByLabel("RTSP URL").fill(CAMERA_SOURCE);
  await page.getByRole("button", { name: "Register camera" }).click();

  // The 409 from the uniqueness constraint has to surface as a sentence, not a
  // silent failure that leaves the operator clicking again.
  await expect(page.getByText(/already exists/i)).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(/\/cameras\/new$/);
});

test("the new camera appears in the list with its state", async ({ page }) => {
  const problems = collectPageProblems(page);
  await page.goto("/cameras");

  const row = page.getByRole("row").filter({ hasText: CAMERA_NAME });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row.getByText(CAMERA_PLACE)).toBeVisible();
  await expect(row.getByText("Enabled")).toBeVisible();

  expect(problems, problems.join("\n")).toEqual([]);
});

test("the detail page shows the configuration that was saved", async ({ page, request }) => {
  const camera = await findCamera(request);
  await page.goto(`/cameras/${camera.camera_id}`);

  await expect(page.getByRole("heading", { name: CAMERA_NAME, level: 5 })).toBeVisible();
  await expect(page.getByText(CAMERA_SOURCE)).toBeVisible();
  await expect(page.getByText("fire_confidence: 0.6")).toBeVisible();
  await expect(page.getByText("kinds: smoke")).toBeVisible();
  await expect(page.getByText("Whole frame")).toBeVisible();
  await expect(page.getByText(CAMERA_PLACE)).toBeVisible();

  // The camera was created enabled, so its worker was started on the spot.
  // With fire alerts off the detector still runs: the panel either lists the
  // boxes it just saw (a GPU worker is already watching the clip) or explains
  // why it is empty -- never an empty table that reads as "nothing in view".
  await expect(
    page
      .getByText(/No fire or smoke in view|Worker is stopped/)
      .or(page.getByRole("columnheader", { name: "In the latest check" }))
  ).toBeVisible();
});

test("the worker can be stopped and started from the detail page", async ({ page, request }) => {
  const camera = await findCamera(request);
  await page.goto(`/cameras/${camera.camera_id}`);

  // Creating an enabled camera starts its worker immediately, so the page may
  // arrive in either state. Wait for the panel to settle first — isVisible()
  // does not wait, and on a page still rendering its loading state it would
  // report false for both buttons and skip straight past this.
  const stop = page.getByRole("button", { name: "Stop worker" });
  const start = page.getByRole("button", { name: "Start worker" });
  await expect(stop.or(start)).toBeVisible({ timeout: 45_000 });

  // Normalise to stopped, then assert the start path.
  if (await stop.isVisible()) {
    await stop.click();
    await expect(start).toBeVisible({ timeout: 45_000 });
  }

  await start.click();

  // The stream manager registers the worker before the RTSP source connects, so
  // this asserts registration — connection depends on mediamtx being up.
  await expect
    .poll(
      async () => {
        const response = await request.get("/api/v1/system/workers", { headers: authHeaders() });
        if (!response.ok()) return false;
        const body = await response.json();
        return (body.data?.workers || []).some((w) => w.camera_id === camera.camera_id);
      },
      { timeout: 60_000 }
    )
    .toBe(true);

  // And the page swaps its primary action without a reload.
  await expect(page.getByRole("button", { name: "Stop worker" })).toBeVisible({ timeout: 30_000 });
});
