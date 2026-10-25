import { expect, test } from "@playwright/test";
import {
  CAMERA_NAME,
  CAMERA_PLACE,
  OPERATOR_CREDENTIALS,
  authHeaders,
  findCamera,
  latestMailTo,
  waitForApi,
} from "./helpers.js";

/**
 * The one spec that runs the detector for real: spec 02's camera reads
 * fire1.mp4 alerting on smoke only. Turning fire on here makes fire.pt confirm
 * the fire in the clip, which has to come out the other end as InsightEye's
 * emergency dialog, an incident with its frame and clip, and the alert email.
 *
 * Needs the api with its model and the mediamtx test source up. On a GPU the
 * alert arrives a few seconds after the worker restarts; on CPU it can take a
 * minute, hence the long waits.
 */
test.describe.configure({ mode: "serial" });

const DETECTION_TIMEOUT = 150_000;

/**
 * Fire alerts back off, and everything the camera raised resolved. Run as the
 * last test and again after all of them: a failure half way through must not
 * leave an OPEN alert, whose dialog would cover every page of the specs after.
 */
async function quietCamera(request) {
  const camera = await findCamera(request);
  if (!camera) return null;
  const settings =
    typeof camera.settings === "string" ? JSON.parse(camera.settings) : camera.settings || {};
  const patched = await request.patch(`/api/v1/cameras/${camera.camera_id}`, {
    headers: authHeaders(),
    data: { settings: { ...settings, kinds: ["smoke"] } },
  });
  expect(patched.ok(), `PATCH camera -> ${patched.status()}`).toBeTruthy();

  const { events = [] } = await (
    await request.get(`/api/v1/events?camera_id=${camera.camera_id}&per_page=100`, {
      headers: authHeaders(),
    })
  ).json();
  for (const event of events.filter((e) => e.status === "OPEN" || e.status === "ACKNOWLEDGED")) {
    await request.patch(`/api/v1/events/${event.event_id}/status`, {
      headers: authHeaders(),
      data: { status: "RESOLVED", action_taken: "E2E: test fire" },
    });
  }
  return camera;
}

test.afterAll(async ({ request }) => {
  await quietCamera(request);
});

/** The live fire incident on the e2e camera, once there is one. */
async function liveFire(request, cameraId) {
  const body = await waitForApi(
    request,
    `/events?camera_id=${cameraId}&kind=fire&live=true&per_page=1`,
    (payload) => payload.total > 0,
    { timeout: DETECTION_TIMEOUT }
  );
  return body.events[0];
}

test("turning fire alerts on raises the emergency alert on the console", async ({
  page,
  request,
}) => {
  test.setTimeout(DETECTION_TIMEOUT + 60_000);
  const camera = await findCamera(request);
  test.skip(!camera, "spec 02 did not leave a camera to alert on");

  await page.goto(`/cameras/${camera.camera_id}/edit`);
  await expect(page.getByLabel("Name")).toHaveValue(CAMERA_NAME);
  await expect(page.getByLabel("Alert on fire")).not.toBeChecked();
  await page.getByLabel("Alert on fire").check();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page).toHaveURL(new RegExp(`/cameras/${camera.camera_id}$`), { timeout: 45_000 });

  // Saving restarts the worker with the new settings; the dialog then opens on
  // whatever page the operator happens to be on.
  const dialog = page.getByTestId("emergency-alert");
  await expect(dialog).toBeVisible({ timeout: DETECTION_TIMEOUT });

  // InsightEye's wording, with the camera's location fields in it.
  await expect(dialog).toContainText("🚨 Emergency Alert");
  await expect(dialog).toContainText(`🚨 FIRE ALERT: FIRE detected in ${CAMERA_PLACE}`);
  await expect(dialog).toContainText(CAMERA_NAME);

  // A fire alert is read, not swatted: no Escape, and Close counts down first.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: /^Close \(\d+\)$/ })).toBeDisabled();

  // The header bell counts it. Not by role: while the dialog is open MUI hides
  // the rest of the page from the accessibility tree.
  await expect(page.locator('a[href="/events?status=OPEN"][aria-label$="unacknowledged alert"]')).toBeVisible();
});

test("acknowledging from the dialog takes the alert off the console", async ({
  page,
  request,
}) => {
  const camera = await findCamera(request);
  test.skip(!camera, "no camera");
  const incident = await liveFire(request, camera.camera_id);
  test.skip(incident.status !== "OPEN", "the alert was already triaged");

  await page.goto("/");
  const dialog = page.getByTestId("emergency-alert");
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await dialog.getByRole("button", { name: "Acknowledge" }).click();

  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await expect(page.getByText("Fire alert acknowledged.")).toBeVisible();

  const stored = await (
    await request.get(`/api/v1/events/${incident.event_id}?include_frame=false`, {
      headers: authHeaders(),
    })
  ).json();
  expect(stored.status).toBe("ACKNOWLEDGED");
  expect(stored.acknowledged_at).toBeTruthy();
  expect(stored.location_text).toBe(CAMERA_PLACE);

  // Off the poll for every console, not just hidden in this tab.
  const active = await (
    await request.get("/api/v1/alerts/active", { headers: authHeaders() })
  ).json();
  expect(active.alerts.some((alert) => alert.event_id === incident.event_id)).toBe(false);
});

test("the incident keeps its annotated frame and an evidence clip", async ({ page, request }) => {
  test.setTimeout(150_000);
  const camera = await findCamera(request);
  test.skip(!camera, "no camera");
  const incident = await liveFire(request, camera.camera_id);

  // The frame is stored with the incident when it is confirmed.
  const frame = await request.get(`/api/v1/events/${incident.event_id}/frame`, {
    headers: authHeaders(),
  });
  expect(frame.status()).toBe(200);
  expect(frame.headers()["content-type"]).toBe("image/jpeg");

  // The clip is saved once its post-roll (CLIP_POST_SECONDS) has been recorded.
  await waitForApi(
    request,
    `/events/${incident.event_id}?include_frame=false`,
    (event) => event.has_clip,
    { timeout: 120_000 }
  );
  const clip = await request.get(`/api/v1/events/${incident.event_id}/clip`, {
    headers: { ...authHeaders(), Range: "bytes=0-1023" },
  });
  expect(clip.status()).toBe(206);
  expect(clip.headers()["content-type"]).toBe("video/mp4");

  // And the detail page plays it rather than saying it is still recording.
  await page.goto(`/events/${incident.event_id}`);
  await expect(page.locator("video")).toBeVisible();
  await expect(page.getByText("Still in view")).toBeVisible();
});

test("the alert email carries the same wording", async ({ request }) => {
  const config = await (
    await request.get("/api/v1/system/config", { headers: authHeaders() })
  ).json();
  test.skip(
    !config.data?.incidents?.alert_email || !process.env.MAILPIT_URL,
    "needs SMTP on the API and MAILPIT_URL to read the mail (see e2e/README.md)"
  );
  // It goes to the camera's workspace members. New users join Default, so the
  // operator global.setup.js created is one; a workspace with no members mails the admins.
  const mail = await latestMailTo(request, `${OPERATOR_CREDENTIALS.username}@example.com`);
  expect(mail).toContain(`🚨 FIRE ALERT: FIRE detected in ${CAMERA_PLACE}`);
  expect(mail).toContain(`Camera:     ${CAMERA_NAME}`);
  // This run's incident, not one left in the sink by an earlier run.
  const camera = await findCamera(request);
  const { events = [] } = await (
    await request.get(`/api/v1/events?camera_id=${camera.camera_id}&kind=fire&per_page=1`, {
      headers: authHeaders(),
    })
  ).json();
  expect(mail).toContain(`Incident ${events[0].event_id}`);
});

test("turning fire alerts back off and resolving leaves nothing open", async ({ request }) => {
  const camera = await quietCamera(request);
  test.skip(!camera, "no camera");

  const active = await (
    await request.get("/api/v1/alerts/active", { headers: authHeaders() })
  ).json();
  expect(active.alerts.filter((alert) => alert.camera_id === camera.camera_id)).toEqual([]);
});
