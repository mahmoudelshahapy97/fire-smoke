import Chip from "@mui/material/Chip";
import Tooltip from "@mui/material/Tooltip";
import LocalFireDepartmentIcon from "@mui/icons-material/LocalFireDepartment";
import CloudIcon from "@mui/icons-material/Cloud";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import { EVENT_STATUS_COLOR, LIVE_STATUS_COLOR } from "../utils/constants";
import { titleCase } from "../utils/format";
import { useTranslation } from "react-i18next";
import i18n from "i18next";

const EVENT_HINT = {
  get OPEN() { return i18n.t("statusChips.nobodyHasAcknowledgedThisAlert"); },
  get ACKNOWLEDGED() { return i18n.t("statusChips.someoneIsDealingWithIt"); },
  get RESOLVED() { return i18n.t("statusChips.handledPutOutOrConfirmed"); },
  get FALSE_POSITIVE() { return i18n.t("statusChips.thereWasNoFireOr"); },
};

const LIVE_HINT = {
  get fire() { return i18n.t("statusChips.fireIsInViewRight"); },
  get smoke() { return i18n.t("statusChips.smokeIsInViewRight"); },
  get clear() { return i18n.t("statusChips.noFireOrSmokeIn"); },
};

const KIND_ICON = {
  fire: <LocalFireDepartmentIcon fontSize="small" />,
  smoke: <CloudIcon fontSize="small" />,
  clear: <CheckCircleOutlineIcon fontSize="small" />,
};

function BaseChip({ value, colors, hints, size, ...props }) {
  if (!value) return null;
  return (
    <Tooltip title={hints[value] || ""}>
      <Chip
        label={titleCase(value)}
        color={colors[value] || "default"}
        size={size}
        variant={colors[value] === "default" ? "outlined" : "filled"}
        {...props}
      />
    </Tooltip>
  );
}

export function EventStatusChip({ status, size = "small", ...props }) {
  return (
    <BaseChip
      value={status}
      colors={EVENT_STATUS_COLOR}
      hints={EVENT_HINT}
      size={size}
      {...props}
    />
  );
}

/** Fire or smoke, with its icon. */
export function KindChip({ kind, size = "small", ...props }) {
  if (!kind) return null;
  return (
    <Chip
      icon={KIND_ICON[kind]}
      label={titleCase(kind)}
      color={LIVE_STATUS_COLOR[kind] || "default"}
      size={size}
      variant="outlined"
      {...props}
    />
  );
}

/** A camera's live status: fire, smoke or clear. Unknown while no worker runs. */
export function LiveStatusChip({ status, size = "small", ...props }) {
  const { t } = useTranslation();
  if (!status) {
    return <Chip label={t("statusChips.notWatching")} size={size} variant="outlined" {...props} />;
  }
  const alerting = status !== "clear";
  return (
    <Tooltip title={LIVE_HINT[status] || ""}>
      <Chip
        icon={KIND_ICON[status]}
        label={alerting ? t("statusChips.v0Detected", { v0: titleCase(status) }) : t("statusChips.clear")}
        color={LIVE_STATUS_COLOR[status] || "default"}
        size={size}
        variant={alerting ? "filled" : "outlined"}
        {...props}
      />
    </Tooltip>
  );
}

/** Whether the camera still sees the incident, or it has cleared. */
export function LiveChip({ live, size = "small", ...props }) {
  const { t } = useTranslation();
  return (
    <Tooltip title={live ? t("statusChips.stillBeingSeenByThe") : t("statusChips.noLongerInView")}>
      <Chip
        label={live ? t("statusChips.live") : t("statusChips.cleared")}
        color={live ? "error" : "default"}
        size={size}
        variant={live ? "filled" : "outlined"}
        {...props}
      />
    </Tooltip>
  );
}

/** Whether a camera is configured to run, which is not whether it *is* running. */
export function EnabledChip({ enabled, size = "small", ...props }) {
  const { t } = useTranslation();
  return (
    <Chip
      label={enabled ? t("statusChips.enabled") : t("statusChips.disabled")}
      color={enabled ? "success" : "default"}
      size={size}
      variant={enabled ? "filled" : "outlined"}
      {...props}
    />
  );
}

/** Whether a worker exists for this camera right now, and whether it has a stream. */
export function WorkerChip({ worker, size = "small", ...props }) {
  const { t } = useTranslation();
  if (!worker || !worker.running) {
    return <Chip label={t("statusChips.stopped")} size={size} variant="outlined" {...props} />;
  }
  return (
    <Tooltip
      title={
        worker.connected
          ? t("statusChips.v0FramesProcessed", { v0: worker.frames_processed ?? 0 })
          : t("statusChips.workerIsUpButThe")
      }
    >
      <Chip
        label={worker.connected ? t("statusChips.streaming") : t("statusChips.reconnecting")}
        color={worker.connected ? "success" : "warning"}
        size={size}
        variant="outlined"
        {...props}
      />
    </Tooltip>
  );
}
