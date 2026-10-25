import client, { mediaUrl } from "./client";

/**
 * One function per backend route, so no component builds a URL by hand.
 *
 * Mirrors app/api/routes/: auth, user, workspace, camera, event (with the
 * /alerts poll), analytics and system routers, all under /api/v1.
 */

// --- health and system ----------------------------------------------------
export const health = {
  // /health is mounted on the app root, outside the versioned prefix, so it is
  // the one call that has to escape the axios baseURL.
  live: (opts) => client.get("/health", { baseURL: "", ...opts }).then((r) => r.data),
};

// --- auth -------------------------------------------------------------------
export const auth = {
  login: (username, password) =>
    client.post("/auth/login", { username, password }).then((r) => r.data),
  refresh: (refreshToken) =>
    client.post("/auth/refresh", { refresh_token: refreshToken }).then((r) => r.data),
  logout: (refreshToken) =>
    client.post("/auth/logout", { refresh_token: refreshToken }).then((r) => r.data),
  logoutAll: () => client.post("/auth/logout-all").then((r) => r.data),
  me: (opts) => client.get("/auth/me", opts).then((r) => r.data),
  changePassword: (currentPassword, newPassword) =>
    client
      .post("/auth/change-password", {
        current_password: currentPassword,
        new_password: newPassword,
      })
      .then((r) => r.data),
  /** Public: what the login page may offer, e.g. {password_reset: true}. */
  options: (opts) => client.get("/auth/options", opts).then((r) => r.data),
  /** Mails a reset code; the answer is the same whether or not the account exists. */
  forgotPassword: (email) =>
    client.post("/auth/forgot-password", { email }).then((r) => r.data),
  resetPassword: ({ email, code, newPassword }) =>
    client
      .post("/auth/reset-password", { email, code, new_password: newPassword })
      .then((r) => r.data),
};

// --- workspaces -------------------------------------------------------------
export const workspaces = {
  /** The caller's workspaces (all of them for admins), Default first. */
  mine: (opts) => client.get("/workspaces/mine", opts).then((r) => r.data),
  // Admin only from here.
  list: (opts) => client.get("/workspaces", opts).then((r) => r.data),
  create: (payload) => client.post("/workspaces", payload).then((r) => r.data),
  update: (id, payload) => client.patch(`/workspaces/${id}`, payload).then((r) => r.data),
  remove: (id) => client.delete(`/workspaces/${id}`).then((r) => r.data),
  members: (id, opts) => client.get(`/workspaces/${id}/members`, opts).then((r) => r.data),
};

// --- users (admin only) ------------------------------------------------------
export const users = {
  list: (opts) => client.get("/users", opts).then((r) => r.data),
  get: (id, opts) => client.get(`/users/${id}`, opts).then((r) => r.data),
  create: (payload) => client.post("/users", payload).then((r) => r.data),
  update: (id, payload) => client.patch(`/users/${id}`, payload).then((r) => r.data),
  resetPassword: (id, newPassword) =>
    client.post(`/users/${id}/reset-password`, { new_password: newPassword }).then((r) => r.data),
  remove: (id) => client.delete(`/users/${id}`).then((r) => r.data),
};

export const system = {
  workers: (opts) => client.get("/system/workers", opts).then((r) => r.data),
  config: (opts) => client.get("/system/config", opts).then((r) => r.data),
};

// --- cameras --------------------------------------------------------------
export const cameras = {
  list: (params, opts) => client.get("/cameras", { params, ...opts }).then((r) => r.data),
  get: (id, opts) => client.get(`/cameras/${id}`, opts).then((r) => r.data),
  create: (payload) => client.post("/cameras", payload).then((r) => r.data),
  update: (id, payload) => client.patch(`/cameras/${id}`, payload).then((r) => r.data),
  remove: (id) => client.delete(`/cameras/${id}`).then((r) => r.data),

  start: (id) => client.post(`/cameras/${id}/start`).then((r) => r.data),
  stop: (id) => client.post(`/cameras/${id}/stop`).then((r) => r.data),
  status: (id, opts) => client.get(`/cameras/${id}/status`, opts).then((r) => r.data),

  /**
   * Latest frame, as an <img> source. The timestamp is not decoration: without
   * it the browser serves the frame it already has and the view never updates.
   */
  snapshotUrl: (id, bust = Date.now()) => mediaUrl(`/cameras/${id}/snapshot`, { t: bust }),

  /**
   * MJPEG live view of the annotated detection output, as an <img> source.
   * Bump `bust` to reconnect after the worker restarts.
   */
  streamUrl: (id, bust = Date.now()) => mediaUrl(`/cameras/${id}/stream`, { t: bust }),
};

// --- events ---------------------------------------------------------------
export const events = {
  list: (params, opts) => client.get("/events", { params, ...opts }).then((r) => r.data),
  get: (id, params, opts) => client.get(`/events/${id}`, { params, ...opts }).then((r) => r.data),
  stats: (params, opts) => client.get("/events/stats", { params, ...opts }).then((r) => r.data),
  /** notes: optional {action_taken, description}; left out, the stored ones are kept. */
  setStatus: (id, status, notes = {}) =>
    client.patch(`/events/${id}/status`, { status, ...notes }).then((r) => r.data),

  /** The annotated frame captured when the incident was confirmed. */
  frameUrl: (id) => mediaUrl(`/events/${id}/frame`),

  /** The annotated mp4 from before the incident was confirmed until after it. */
  clipUrl: (id) => mediaUrl(`/events/${id}/clip`),
};

// --- alerts ---------------------------------------------------------------
export const alerts = {
  /** Unacknowledged alerts in the active workspace: {count, alerts: [...]} */
  active: (opts) => client.get("/alerts/active", opts).then((r) => r.data),
};

// --- analytics ------------------------------------------------------------
export const analytics = {
  /** {days, camera_id, tz} -> KPIs, series, heatmap and breakdowns for one window. */
  summary: (params, opts) =>
    client.get("/analytics/summary", { params, ...opts }).then((r) => r.data),
  /** {days, camera_id, tz} -> detector confidence histogram, spread per camera, latest alerts. */
  confidenceAudit: (params, opts) =>
    client.get("/analytics/confidence-audit", { params, ...opts }).then((r) => r.data),
  /** {days, tz} -> every camera with incidents, days with each kind and detection rates. */
  byCamera: (params, opts) =>
    client.get("/analytics/by-camera", { params, ...opts }).then((r) => r.data),
  /** {group_by, days, tz} -> the per-camera numbers per building / floor / zone / area. */
  byLocation: (params, opts) =>
    client.get("/analytics/by-location", { params, ...opts }).then((r) => r.data),
  /** {threshold_percentage, days, tz} -> cameras at or above the detection-rate threshold. */
  highRisk: (params, opts) =>
    client.get("/analytics/high-risk", { params, ...opts }).then((r) => r.data),
};

export default {
  health,
  auth,
  users,
  system,
  cameras,
  events,
  alerts,
  analytics,
};
