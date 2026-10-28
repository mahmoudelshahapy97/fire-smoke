import { useEffect, useState } from "react";
import { Link as RouterLink, useParams } from "react-router-dom";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import Divider from "@mui/material/Divider";
import Grid from "@mui/material/Grid2";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";

import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import DoneAllIcon from "@mui/icons-material/DoneAll";
import ThumbDownOffAltIcon from "@mui/icons-material/ThumbDownOffAlt";

import ItemImage from "../components/ItemImage";
import PageHeader from "../components/PageHeader";
import { ErrorState, Loading } from "../components/DataStates";
import { EventStatusChip, KindChip, LiveChip } from "../components/StatusChips";
import { useToast } from "../components/Toast";
import { errorMessage } from "../api/client";
import { events as eventApi } from "../api/endpoints";
import { useAuth } from "../auth/AuthContext";
import { useAsync } from "../hooks/useAsync";
import { EVENT_STATUS, POLL_INTERVAL_MS } from "../utils/constants";
import {
  describeBox,
  formatDateTime,
  formatDuration,
  formatScore,
  fromNow,
  incidentSeconds,
  shortId,
  titleCase,
} from "../utils/format";
import { useTranslation } from "react-i18next";
import i18n from "i18next";

function DetailRow({ label, children }) {
  return (
    <Stack direction="row" spacing={2} sx={{ py: 1 }}>
      <Typography variant="body2" color="text.secondary" sx={{ minWidth: 150, flexShrink: 0 }}>
        {label}
      </Typography>
      <Box sx={{ flex: 1, minWidth: 0 }}>{children}</Box>
    </Stack>
  );
}

/** The three ways an operator closes out an alert. */
const TRIAGE = [
  {
    status: EVENT_STATUS.ACKNOWLEDGED,
    get label() { return i18n.t("eventDetail.acknowledge"); },
    icon: <CheckCircleOutlineIcon />,
    color: "warning",
  },
  { status: EVENT_STATUS.RESOLVED, get label() { return i18n.t("eventDetail.resolve"); }, icon: <DoneAllIcon />, color: "success" },
  {
    status: EVENT_STATUS.FALSE_POSITIVE,
    get label() { return i18n.t("eventDetail.falsePositive"); },
    icon: <ThumbDownOffAltIcon />,
    color: "inherit",
  },
];

const TRIAGE_HINT = {
  get [EVENT_STATUS.ACKNOWLEDGED]() { return i18n.t("eventDetail.someoneIsOnItThe"); },
  get [EVENT_STATUS.RESOLVED]() { return i18n.t("eventDetail.itWasDealtWithPut"); },
  get [EVENT_STATUS.FALSE_POSITIVE]() { return i18n.t("eventDetail.thereWasNoFireOr"); },
};

/** Confirms a triage step and records how the alert was handled. */
function TriageDialog({ open, status, label, initial, busy, onConfirm, onClose }) {
  const { t } = useTranslation();
  const [actionTaken, setActionTaken] = useState("");
  const [description, setDescription] = useState("");

  const reset = () => {
    setActionTaken(initial?.action_taken || "");
    setDescription(initial?.description || "");
  };

  return (
    <Dialog
      open={open}
      onClose={busy ? undefined : onClose}
      maxWidth="sm"
      fullWidth
      TransitionProps={{ onEnter: reset }}
    >
      <DialogTitle>{label}</DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ mb: 2 }}>{TRIAGE_HINT[status]}</DialogContentText>
        <Stack spacing={2}>
          <TextField
            label={t("eventDetail.actionTaken")}
            placeholder={t("eventDetail.eGFireTeamCalled")}
            value={actionTaken}
            onChange={(event) => setActionTaken(event.target.value)}
            inputProps={{ maxLength: 200 }}
            fullWidth
            autoFocus
          />
          <TextField
            label={t("eventDetail.notes")}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            inputProps={{ maxLength: 2000 }}
            multiline
            minRows={3}
            fullWidth
          />
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={busy} color="inherit">
          {t("eventDetail.cancel")}
        </Button>
        <Button
          variant="contained"
          disabled={busy}
          onClick={() => onConfirm({ action_taken: actionTaken.trim(), description: description.trim() })}
        >
          {busy ? t("eventDetail.working") : label}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default function EventDetail() {
  const { t } = useTranslation();
  const { eventId } = useParams();
  const toast = useToast();
  const { hasRole } = useAuth();
  const canTriage = hasRole("operator");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(null); // the TRIAGE step being confirmed

  // include_frame=false: the annotated frame is fetched as an image instead, so
  // it streams and caches rather than riding along base64-inflated in the JSON.
  const { data, error, loading, refresh } = useAsync(
    ({ signal }) => eventApi.get(eventId, { include_frame: false }, { signal }),
    [eventId]
  );

  const setStatus = async (status, notes) => {
    setBusy(true);
    try {
      // Empty fields are left out so the notes already stored are kept.
      const filled = Object.fromEntries(Object.entries(notes || {}).filter(([, v]) => v));
      await eventApi.setStatus(eventId, status, filled);
      toast.success(t("eventDetail.incidentMarkedV0", { v0: titleCase(status).toLowerCase() }));
      setPending(null);
      refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  // While the camera still sees it, keep the timeline current.
  const live = Boolean(data?.live);
  useEffect(() => {
    if (!live) return undefined;
    const timer = setInterval(() => !document.hidden && refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [live, refresh]);

  if (loading && !data) return <Loading label={t("eventDetail.loadingIncident")} />;
  if (error) return <ErrorState error={error} onRetry={refresh} />;
  if (!data) return null;

  return (
    <Box>
      <Button component={RouterLink} to="/events" startIcon={<ArrowBackIcon />} sx={{ mb: 2 }}>
        {t("eventDetail.allIncidents")}
      </Button>

      <PageHeader
        title={t("eventDetail.v0OnV1", { v0: titleCase(data.kind), v1: data.camera_name || t("eventDetail.anUnknownCamera") })}
        subtitle={`${data.location_text || t("eventDetail.unknownLocation")} · ${fromNow(data.detected_at)}`}
        actions={
          canTriage &&
          TRIAGE.map(({ status, label, icon, color }) => (
            <Button
              key={status}
              variant={data.status === status ? "contained" : "outlined"}
              color={color}
              startIcon={icon}
              disabled={busy || data.status === status}
              onClick={() => setPending({ status, label })}
            >
              {label}
            </Button>
          ))
        }
      />

      <TriageDialog
        open={Boolean(pending)}
        status={pending?.status}
        label={pending?.label}
        initial={data}
        busy={busy}
        onConfirm={(notes) => setStatus(pending.status, notes)}
        onClose={() => setPending(null)}
      />

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, lg: 7 }}>
          <Card sx={{ mb: 2 }}>
            <Box sx={{ px: 2.5, py: 1.5 }}>
              <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                {t("eventDetail.video")}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {t("eventDetail.annotatedFootageFromBeforeThe")}
              </Typography>
            </Box>
            <Divider />
            {data.has_clip ? (
              <Box
                component="video"
                controls
                preload="metadata"
                src={eventApi.clipUrl(eventId)}
                sx={{ width: "100%", maxHeight: 420, display: "block", bgcolor: "common.black" }}
              />
            ) : (
              <Typography variant="body2" color="text.secondary" sx={{ px: 2.5, py: 3 }}>
                {data.live
                  ? t("eventDetail.theClipIsStillRecording")
                  : t("eventDetail.noClipRecordedForThis")}
              </Typography>
            )}
          </Card>

          <Card>
            <Box sx={{ px: 2.5, py: 1.5 }}>
              <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                {t("eventDetail.alertFrame")}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {t("eventDetail.theAnnotatedFrameCapturedThe")}
              </Typography>
            </Box>
            <Divider />
            <ItemImage
              src={eventApi.frameUrl(eventId)}
              alt={t("eventDetail.annotatedFrameOfTheKind", { kind: data.kind, camera_name: data.camera_name })}
              height={420}
              fit="contain"
              fallbackLabel={t("eventDetail.noFrameStoredForThis")}
            />
          </Card>
        </Grid>

        <Grid size={{ xs: 12, lg: 5 }}>
          <Card>
            <CardContent>
              <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>
                {t("eventDetail.detection")}
              </Typography>
              <Divider />
              <DetailRow label={t("eventDetail.status")}>
                <EventStatusChip status={data.status} />
              </DetailRow>
              <DetailRow label={t("eventDetail.kind")}>
                <Stack direction="row" spacing={1}>
                  <KindChip kind={data.kind} />
                  <LiveChip live={data.live} />
                </Stack>
              </DetailRow>
              <DetailRow label={t("eventDetail.peakConfidence")}>
                <Typography variant="body2">{formatScore(data.peak_confidence)}</Typography>
              </DetailRow>
              <DetailRow label={t("eventDetail.sightings")}>
                <Typography variant="body2">
                  {t("eventDetail.v0CheckV1SawIt", { v0: data.sightings ?? "—", v1: data.sightings === 1 ? "" : "s" })}
                </Typography>
              </DetailRow>
              <DetailRow label={t("eventDetail.peakBox")}>
                <Typography variant="body2" color="text.secondary">
                  {describeBox(data.bbox)}
                  {data.detections?.length > 1 ? t("eventDetail.v0MoreInThatFrame", { v0: data.detections.length - 1 }) : ""}
                </Typography>
              </DetailRow>
              <DetailRow label={t("eventDetail.location")}>
                <Typography variant="body2">{data.location_text || "—"}</Typography>
              </DetailRow>
            </CardContent>
          </Card>

          <Card sx={{ mt: 2 }}>
            <CardContent>
              <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>
                {t("eventDetail.timeline")}
              </Typography>
              <Divider />
              <DetailRow label={t("eventDetail.firstSeen")}>
                <Typography variant="body2" color="text.secondary">
                  {formatDateTime(data.started_at)}
                </Typography>
              </DetailRow>
              <DetailRow label={t("eventDetail.confirmedAlertSent")}>
                <Typography variant="body2">{formatDateTime(data.detected_at)}</Typography>
              </DetailRow>
              <DetailRow label={t("eventDetail.lastSeen")}>
                <Typography variant="body2" color="text.secondary">
                  {formatDateTime(data.last_seen_at)}
                </Typography>
              </DetailRow>
              <DetailRow label={t("eventDetail.cleared")}>
                <Typography variant="body2" color="text.secondary">
                  {data.cleared_at ? formatDateTime(data.cleared_at) : t("eventDetail.stillInView")}
                </Typography>
              </DetailRow>
              <DetailRow label={t("eventDetail.inViewFor")}>
                <Typography variant="body2">{formatDuration(incidentSeconds(data))}</Typography>
              </DetailRow>
              <DetailRow label={t("eventDetail.identity")}>
                <Typography variant="caption" color="text.disabled">
                  {t("eventDetail.incidentV0", { v0: shortId(data.event_id) })}
                </Typography>
              </DetailRow>
            </CardContent>
          </Card>

          {data.acknowledged_at || data.action_taken || data.description ? (
            <Card sx={{ mt: 2 }}>
              <CardContent>
                <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>
                  {t("eventDetail.handling")}
                </Typography>
                <Divider />
                <DetailRow label={t("eventDetail.acknowledged")}>
                  <Typography variant="body2" color="text.secondary">
                    {formatDateTime(data.acknowledged_at)}
                    {data.acknowledged_by_username ? t("eventDetail.byAcknowledgedByUsername", { acknowledged_by_username: data.acknowledged_by_username }) : ""}
                  </Typography>
                </DetailRow>
                <DetailRow label={t("eventDetail.closed")}>
                  <Typography variant="body2" color="text.secondary">
                    {data.resolved_at
                      ? `${formatDateTime(data.resolved_at)}${
                          data.resolved_by_username ? ` by ${data.resolved_by_username}` : ""
                        }`
                      : t("eventDetail.stillOpen")}
                  </Typography>
                </DetailRow>
                <DetailRow label={t("eventDetail.actionTaken")}>
                  <Typography variant="body2">{data.action_taken || "—"}</Typography>
                </DetailRow>
                <DetailRow label={t("eventDetail.notes")}>
                  <Typography variant="body2" sx={{ whiteSpace: "pre-wrap" }}>
                    {data.description || "—"}
                  </Typography>
                </DetailRow>
              </CardContent>
            </Card>
          ) : null}

        </Grid>
      </Grid>
    </Box>
  );
}
