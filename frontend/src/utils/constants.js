import i18n from "i18next";
/**
 * Mirrors the enums in app/schemas/ and app/services/fire_monitor.py — keep the
 * two in step. The CHECK constraints in database/schema.sql are the ultimate
 * authority on which values a column will accept.
 */

/** fire_event.status — the operator's triage. */
export const EVENT_STATUS = {
  OPEN: "OPEN",
  ACKNOWLEDGED: "ACKNOWLEDGED",
  RESOLVED: "RESOLVED",
  FALSE_POSITIVE: "FALSE_POSITIVE",
};

/** fire_event.kind */
export const EVENT_KIND = {
  FIRE: "fire",
  SMOKE: "smoke",
};

/** A camera's live status as FireMonitor reports it: the most severe live kind. */
export const LIVE_STATUS = {
  FIRE: "fire",
  SMOKE: "smoke",
  CLEAR: "clear",
};

export const EVENT_STATUSES = Object.values(EVENT_STATUS);
export const EVENT_KINDS = Object.values(EVENT_KIND);

/** MUI palette keys, so a status colours identically everywhere it appears. */
export const EVENT_STATUS_COLOR = {
  OPEN: "error",
  ACKNOWLEDGED: "warning",
  RESOLVED: "success",
  FALSE_POSITIVE: "default",
};

export const LIVE_STATUS_COLOR = {
  fire: "error",
  smoke: "warning",
  clear: "success",
};

/**
 * Chart colours per kind. Fire is red; smoke is a slate grey-blue, which stays
 * distinguishable from the red for red-green colour-blind viewers and reads in
 * both themes.
 */
export const KIND_COLOR = {
  fire: "#dc2626",
  smoke: "#64748b",
};

export const POLL_INTERVAL_MS = Number(import.meta.env.VITE_POLL_INTERVAL_MS) || 5000;

/** How often the console asks whether anything is on fire. */
export const ALERT_POLL_MS = Number(import.meta.env.VITE_ALERT_POLL_MS) || 3000;

/**
 * InsightEye's emergency dialog cannot be dismissed for this long: a fire
 * alert is read, not swatted away. Acknowledging it is possible at once.
 */
export const ALERT_CLOSE_DELAY_S = 10;

/** Default page size, matched to the API's per_page default. */
export const PAGE_SIZE = 20;
export const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

/** What analytics may group cameras by (app/services/analytics_service.py). */
export const LOCATION_GROUPS = [
  { value: "building", get label() { return i18n.t("constants.building"); } },
  { value: "floor_level", get label() { return i18n.t("constants.floor"); } },
  { value: "zone", get label() { return i18n.t("constants.zone"); } },
  { value: "area", get label() { return i18n.t("constants.area"); } },
  { value: "location", get label() { return i18n.t("constants.location"); } },
];
