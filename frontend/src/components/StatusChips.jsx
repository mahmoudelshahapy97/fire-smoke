import Chip from "@mui/material/Chip";
import Tooltip from "@mui/material/Tooltip";
import LocalFireDepartmentIcon from "@mui/icons-material/LocalFireDepartment";
import CloudIcon from "@mui/icons-material/Cloud";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import { EVENT_STATUS_COLOR, LIVE_STATUS_COLOR } from "../utils/constants";
import { titleCase } from "../utils/format";

const EVENT_HINT = {
  OPEN: "Nobody has acknowledged this alert yet",
  ACKNOWLEDGED: "Someone is dealing with it",
  RESOLVED: "Handled: put out, or confirmed safe",
  FALSE_POSITIVE: "There was no fire or smoke",
};

const LIVE_HINT = {
  fire: "Fire is in view right now",
  smoke: "Smoke is in view right now",
  clear: "No fire or smoke in view",
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
  if (!status) {
    return <Chip label="Not watching" size={size} variant="outlined" {...props} />;
  }
  const alerting = status !== "clear";
  return (
    <Tooltip title={LIVE_HINT[status] || ""}>
      <Chip
        icon={KIND_ICON[status]}
        label={alerting ? `${titleCase(status)} detected` : "Clear"}
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
  return (
    <Tooltip title={live ? "Still being seen by the camera" : "No longer in view"}>
      <Chip
        label={live ? "Live" : "Cleared"}
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
  return (
    <Chip
      label={enabled ? "Enabled" : "Disabled"}
      color={enabled ? "success" : "default"}
      size={size}
      variant={enabled ? "filled" : "outlined"}
      {...props}
    />
  );
}

/** Whether a worker exists for this camera right now, and whether it has a stream. */
export function WorkerChip({ worker, size = "small", ...props }) {
  if (!worker || !worker.running) {
    return <Chip label="Stopped" size={size} variant="outlined" {...props} />;
  }
  return (
    <Tooltip
      title={
        worker.connected
          ? `${worker.frames_processed ?? 0} frames processed`
          : "Worker is up but the RTSP source is not answering"
      }
    >
      <Chip
        label={worker.connected ? "Streaming" : "Reconnecting"}
        color={worker.connected ? "success" : "warning"}
        size={size}
        variant="outlined"
        {...props}
      />
    </Tooltip>
  );
}
