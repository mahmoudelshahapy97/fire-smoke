import { expect, test } from "@playwright/test";
import {
  CAMERA_NAME,
  CAMERA_SOURCE,
  SEED,
  authHeaders,
  collectPageProblems,
  findCamera,
} from "./helpers.js";

/**
 * The rest of the camera lifecycle: edit it, stop its worker, delete it. Runs
 * last because it dismantles what spec 02 created, and leaves the database as
 * it found it: deleting the camera also removes spec 04's incident.
 */
test.describe.configure({ mode: "serial" });

const NEW_AREA = "Shutter 2";

test("editing a camera persists the change without clearing the rest", async ({
  page,
  request,
}) => {
  const problems = collectPageProblems(page);
  const camera = await findCamera(request);
  test.skip(!camera, "spec 02 did not leave a camera to edit");

  await page.goto(`/cameras/${camera.camera_id}`);
  await page.getByRole("link", { name: "Edit", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/cameras/${camera.camera_id}/edit$`));

  // The form must arrive populated, not blank — an edit form that loses the
  // source would silently unregister the stream on save.
  await expect(page.getByLabel("Name")).toHaveValue(CAMERA_NAME);
  await expect(page.getByLabel("RTSP URL")).toHaveValue(CAMERA_SOURCE);
  // Overrides live in jsonb; they have to survive the round trip through the
  // form as numbers, not as the strings an input hands back.
  await expect(page.getByLabel("Fire confidence")).toHaveValue("0.6");
  // Spec 04 turned fire alerts back off.
  await expect(page.getByLabel("Alert on fire")).not.toBeChecked();
  await expect(page.getByLabel("Alert on smoke")).toBeChecked();

  await page.getByLabel("Area").fill(NEW_AREA);
  await page.getByRole("button", { name: "Save changes" }).click();

  await expect(page).toHaveURL(new RegExp(`/cameras/${camera.camera_id}$`), { timeout: 45_000 });
  await expect(page.getByText(`E2E Warehouse - Floor 1 - Dock - ${NEW_AREA}`).first()).toBeVisible();

  const updated = await findCamera(request);
  expect(updated.area).toBe(NEW_AREA);
  expect(updated.building).toBe("E2E Warehouse");
  expect(updated.rtsp_url).toBe(CAMERA_SOURCE);
  const settings =
    typeof updated.settings === "string" ? JSON.parse(updated.settings) : updated.settings;
  expect(settings.fire_confidence).toBe(0.6);
  expect(settings.kinds).toEqual(["smoke"]);

  expect(problems, problems.join("\n")).toEqual([]);
});

test("stopping the worker removes it from the live status", async ({ page, request }) => {
  const camera = await findCamera(request);
  test.skip(!camera, "no camera to stop");

  await page.goto(`/cameras/${camera.camera_id}`);

  // Wait for the worker panel to settle before reading it: isVisible() does not
  // wait, so on a page still rendering its loading state this would report false
  // and skip a test that had nothing wrong with it.
  const stop = page.getByRole("button", { name: "Stop worker" });
  const start = page.getByRole("button", { name: "Start worker" });
  await expect(stop.or(start)).toBeVisible({ timeout: 45_000 });

  test.skip(!(await stop.isVisible()), "worker is not running");
  await stop.click();

  await expect
    .poll(
      async () => {
        const response = await request.get("/api/v1/system/workers", { headers: authHeaders() });
        if (!response.ok()) return true;
        const body = await response.json();
        return (body.data?.workers || []).some((w) => w.camera_id === camera.camera_id);
      },
      { timeout: 60_000 }
    )
    .toBe(false);

  // The page reflects it without a reload.
  await expect(start).toBeVisible({ timeout: 30_000 });
});

test("deleting the camera removes it from the list and the API", async ({ page, request }) => {
  const problems = collectPageProblems(page);
  const camera = await findCamera(request);
  test.skip(!camera, "no camera to delete");

  await page.goto(`/cameras/${camera.camera_id}`);
  await page.getByRole("button", { name: "Delete", exact: true }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Delete" }).click();

  await expect(page).toHaveURL(/\/cameras$/, { timeout: 45_000 });
  await expect(page.getByRole("row").filter({ hasText: CAMERA_NAME })).toHaveCount(0);

  expect(await findCamera(request)).toBeNull();
  const gone = await request.get(`/api/v1/cameras/${camera.camera_id}`, { headers: authHeaders() });
  expect(gone.status()).toBe(404);

  expect(problems, problems.join("\n")).toEqual([]);
});

test("the seeded cameras are untouched", async ({ request }) => {
  // The suite must not have taken anything else with it: deleting a camera
  // cascades to its incidents, so a stray delete would silently gut the seed.
  const cameras = await (await request.get("/api/v1/cameras", { headers: authHeaders() })).json();
  expect(cameras.length).toBeGreaterThanOrEqual(4);
  expect(cameras.some((camera) => camera.name === SEED.cameraName)).toBe(true);
  const seeded = await request.get(`/api/v1/events/${SEED.resolvedFireId}?include_frame=false`, {
    headers: authHeaders(),
  });
  expect(seeded.ok()).toBeTruthy();
});
