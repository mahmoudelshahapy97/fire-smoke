import { useEffect, useMemo, useState } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Badge from "@mui/material/Badge";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import NotificationsActiveIcon from "@mui/icons-material/NotificationsActive";
import NotificationsNoneIcon from "@mui/icons-material/NotificationsNone";

import { events } from "../api/endpoints";
import { errorMessage } from "../api/client";
import { useAlerts } from "../alerts/AlertsContext";
import { useAuth } from "../auth/AuthContext";
import { useToast } from "./Toast";
import ItemImage from "./ItemImage";
import { KindChip, LiveChip } from "./StatusChips";
import { ALERT_CLOSE_DELAY_S } from "../utils/constants";
import { formatScore, fromNow } from "../utils/format";

/** Alerts closed in this tab without acknowledging them, so they do not pop up again. */
const DISMISSED_KEY = "fire-smoke:dismissed-alerts";

function loadDismissed() {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(DISMISSED_KEY) || "[]"));
  } catch {
    return new Set();
  }
}

function saveDismissed(ids) {
  try {
    sessionStorage.setItem(DISMISSED_KEY, JSON.stringify([...ids].slice(-200)));
  } catch {
    // Private mode: dismissals last until the page reloads.
  }
}

/**
 * InsightEye's "🚨 Emergency Alert" dialog, fed by the alert poll.
 *
 * It opens for the newest alert nobody has acknowledged, cannot be clicked or
 * escaped away, and offers Close only after ALERT_CLOSE_DELAY_S seconds -- a
 * fire alert is read, not swatted. Operators can acknowledge at once, which
 * takes it off every console; closing only hides it in this tab.
 */
export function EmergencyAlert() {
  const { alerts, count, refresh } = useAlerts();
  const { hasRole } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [dismissed, setDismissed] = useState(loadDismissed);
  const [busy, setBusy] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(ALERT_CLOSE_DELAY_S);

  const pending = useMemo(
    () => alerts.filter((alert) => !dismissed.has(alert.event_id)),
    [alerts, dismissed]
  );
  const current = pending[0];
  const currentId = current?.event_id;

  // Restart the countdown for every alert shown.
  useEffect(() => {
    if (!currentId) return undefined;
    setSecondsLeft(ALERT_CLOSE_DELAY_S);
    const timer = setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(timer);
  }, [currentId]);

  if (!current) return null;

  const dismiss = (eventId) => {
    const next = new Set(dismissed);
    next.add(eventId);
    setDismissed(next);
    saveDismissed(next);
  };

  const acknowledge = async () => {
    setBusy(true);
    try {
      await events.setStatus(current.event_id, "ACKNOWLEDGED");
      toast.success(`${current.kind === "fire" ? "Fire" : "Smoke"} alert acknowledged.`);
      dismiss(current.event_id);
      refresh();
    } catch (err) {
      toast.error(errorMessage(err) || "Could not acknowledge the alert.");
    } finally {
      setBusy(false);
    }
  };

  const open = () => {
    dismiss(current.event_id);
    navigate(`/events/${current.event_id}`);
  };

  const others = count - 1;
  const isFire = current.kind === "fire";

  return (
    <Dialog
      open
      maxWidth="sm"
      fullWidth
      disableEscapeKeyDown
      // Backdrop clicks are ignored on purpose (InsightEye's behaviour).
      onClose={() => {}}
      aria-labelledby="emergency-alert-title"
      PaperProps={{
        sx: { border: 2, borderColor: isFire ? "error.main" : "warning.main" },
        "data-testid": "emergency-alert",
      }}
    >
      <DialogTitle
        id="emergency-alert-title"
        sx={{ bgcolor: isFire ? "error.main" : "warning.main", color: "common.white", fontWeight: 800 }}
      >
        🚨 Emergency Alert
      </DialogTitle>
      <DialogContent sx={{ pt: "20px !important" }}>
        <Stack spacing={2}>
          <Typography variant="h6" sx={{ fontWeight: 700 }}>
            {current.message}
          </Typography>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <KindChip kind={current.kind} />
            <LiveChip live={current.live} />
            <Typography variant="body2" color="text.secondary">
              {current.camera_name || "Unknown camera"} · {fromNow(current.detected_at)} ·
              confidence {formatScore(current.peak_confidence)}
            </Typography>
          </Stack>
          <ItemImage
            key={current.event_id}
            src={events.frameUrl(current.event_id)}
            alt={`Frame of the ${current.kind} on ${current.camera_name}`}
            height={240}
            fit="contain"
            fallbackLabel="Frame not stored yet"
          />
          {others > 0 && (
            <Alert severity="warning" variant="outlined">
              {others} more unacknowledged alert{others === 1 ? "" : "s"}.{" "}
              <Box component={RouterLink} to="/events?status=OPEN" onClick={() => dismiss(current.event_id)}>
                See all
              </Box>
            </Alert>
          )}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button
          onClick={() => dismiss(current.event_id)}
          disabled={secondsLeft > 0}
          color="inherit"
        >
          {secondsLeft > 0 ? `Close (${secondsLeft})` : "Close"}
        </Button>
        <Button onClick={open} variant="outlined">
          View incident
        </Button>
        {hasRole("operator") && (
          <Button onClick={acknowledge} variant="contained" color="error" disabled={busy}>
            Acknowledge
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}

/** The header bell: how many alerts nobody has acknowledged. */
export function AlertBadge() {
  const { count, error } = useAlerts();
  const label = error
    ? "Could not check for alerts"
    : count
      ? `${count} unacknowledged alert${count === 1 ? "" : "s"}`
      : "No open alerts";
  return (
    <Tooltip title={label}>
      <IconButton component={RouterLink} to="/events?status=OPEN" aria-label={label}>
        <Badge badgeContent={count} color="error" max={99}>
          {count ? <NotificationsActiveIcon color="error" /> : <NotificationsNoneIcon />}
        </Badge>
      </IconButton>
    </Tooltip>
  );
}

export default EmergencyAlert;
