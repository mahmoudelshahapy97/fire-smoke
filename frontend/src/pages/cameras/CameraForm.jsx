import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Divider from "@mui/material/Divider";
import FormControlLabel from "@mui/material/FormControlLabel";
import Grid from "@mui/material/Grid2";
import InputAdornment from "@mui/material/InputAdornment";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";

import { errorMessage } from "../../api/client";
import { cameras as camerasApi } from "../../api/endpoints";
import { useAsync } from "../../hooks/useAsync";
import { useToast } from "../../components/Toast";
import { ErrorState, Loading } from "../../components/DataStates";
import PageHeader from "../../components/PageHeader";
import { parseJsonField } from "../../utils/format";

const LOCATION_FIELDS = [
  { key: "building", label: "Building", placeholder: "Warehouse A", max: 100 },
  { key: "floor_level", label: "Floor", placeholder: "2", max: 20 },
  { key: "zone", label: "Zone", placeholder: "Loading bay", max: 100 },
  { key: "area", label: "Area", placeholder: "Dock 3", max: 100 },
];

/**
 * The incident rules a camera may override, mirroring FireParams and the
 * per-kind thresholds in app/services/fire_detector.py. They live in the
 * `settings` jsonb rather than in columns of their own, so an absent key means
 * "inherit the global .env value" — a different thing from 0, which is why
 * blanks are omitted from the payload rather than sent as zero.
 */
const OVERRIDE_FIELDS = [
  {
    key: "fire_confidence",
    label: "Fire confidence",
    unit: "0-1",
    help: "A fire box needs at least this score to count. InsightEye used 0.5.",
    min: 0.05,
    max: 1,
    step: 0.05,
  },
  {
    key: "smoke_confidence",
    label: "Smoke confidence",
    unit: "0-1",
    help: "The same for smoke. Lower it for a camera that sees smoke only faintly.",
    min: 0.05,
    max: 1,
    step: 0.05,
  },
  {
    key: "confirm_hits",
    label: "Confirm after",
    unit: "checks",
    help: "Sightings needed within the window below before the alert goes out.",
    min: 1,
    max: 30,
  },
  {
    key: "confirm_window",
    label: "Out of the last",
    unit: "checks",
    help: "The detector checks about twice a second, so 5 checks is 2.5 s.",
    min: 1,
    max: 30,
  },
  {
    key: "clear_after_s",
    label: "Clear after",
    unit: "s",
    help: "An incident closes once nothing has been seen for this long.",
    min: 1,
    max: 3600,
  },
  {
    key: "cooldown_s",
    label: "Cooldown",
    unit: "s",
    help: "Seen again within this long of clearing, the same incident reopens — no new alert.",
    min: 0,
    max: 86400,
  },
];

const KINDS = ["fire", "smoke"];

const EMPTY = {
  name: "",
  location: "",
  rtsp_url: "",
  enabled: true,
  ...Object.fromEntries(LOCATION_FIELDS.map(({ key }) => [key, ""])),
  ...Object.fromEntries(OVERRIDE_FIELDS.map(({ key }) => [key, ""])),
  kind_fire: true,
  kind_smoke: true,
};

function validate(values) {
  const errors = {};
  if (!values.name.trim()) errors.name = "Required";
  else if (values.name.length > 120) errors.name = "At most 120 characters";

  if (!values.rtsp_url.trim()) errors.rtsp_url = "Required";
  if (values.location.length > 200) errors.location = "At most 200 characters";
  LOCATION_FIELDS.forEach(({ key, max }) => {
    if (values[key].length > max) errors[key] = `At most ${max} characters`;
  });

  OVERRIDE_FIELDS.forEach(({ key, min, max }) => {
    const raw = values[key];
    if (raw === "" || raw === null || raw === undefined) return;
    const value = Number(raw);
    if (Number.isNaN(value)) errors[key] = "Must be a number";
    else if (value < min || value > max) errors[key] = `Between ${min} and ${max}`;
  });

  // The backend clamps hits to the window, but asking for 6 of 5 is a typo
  // worth catching here.
  const hits = values.confirm_hits === "" ? null : Number(values.confirm_hits);
  const window = values.confirm_window === "" ? null : Number(values.confirm_window);
  if (hits !== null && window !== null && hits > window) {
    errors.confirm_hits = "Cannot exceed the window";
  }
  if (!values.kind_fire && !values.kind_smoke) {
    errors.kinds = "Alert on at least one of fire and smoke";
  }

  return errors;
}

export default function CameraForm() {
  const { cameraId } = useParams();
  const isEdit = Boolean(cameraId);
  const navigate = useNavigate();
  const toast = useToast();

  const [values, setValues] = useState(EMPTY);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState(null);

  const {
    data: camera,
    error: loadError,
    loading,
    refresh,
  } = useAsync(({ signal }) => camerasApi.get(cameraId, { signal }), [cameraId], {
    enabled: isEdit,
  });

  useEffect(() => {
    if (!camera) return;
    const settings = parseJsonField(camera.settings, {}) || {};
    const kinds = Array.isArray(settings.kinds) ? settings.kinds : KINDS;
    setValues({
      name: camera.name ?? "",
      location: camera.location ?? "",
      rtsp_url: camera.rtsp_url ?? "",
      enabled: camera.enabled ?? true,
      ...Object.fromEntries(LOCATION_FIELDS.map(({ key }) => [key, camera[key] ?? ""])),
      ...Object.fromEntries(OVERRIDE_FIELDS.map(({ key }) => [key, settings[key] ?? ""])),
      kind_fire: kinds.includes("fire"),
      kind_smoke: kinds.includes("smoke"),
    });
  }, [camera]);

  const setField = (field) => (event) => {
    const value = event.target.type === "checkbox" ? event.target.checked : event.target.value;
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined, kinds: undefined }));
  };

  const payload = useMemo(() => {
    const settings = {};
    OVERRIDE_FIELDS.forEach(({ key }) => {
      const raw = values[key];
      // Omitted, not zeroed: an absent key is what "inherit the default" means.
      if (raw !== "" && raw !== null && raw !== undefined) settings[key] = Number(raw);
    });
    const kinds = KINDS.filter((kind) => values[`kind_${kind}`]);
    // Both kinds is the default, so it is left out like any other default.
    if (kinds.length !== KINDS.length) settings.kinds = kinds;

    return {
      name: values.name.trim(),
      rtsp_url: values.rtsp_url.trim(),
      // Empty strings rather than null: a PATCH skips nulls, so "" is how a
      // field is cleared.
      location: values.location.trim(),
      ...Object.fromEntries(LOCATION_FIELDS.map(({ key }) => [key, values[key].trim()])),
      enabled: values.enabled,
      settings,
    };
  }, [values]);

  const submit = async (event) => {
    event.preventDefault();
    const found = validate(values);
    setErrors(found);
    if (Object.keys(found).length) return;

    setSaving(true);
    setSubmitError(null);
    try {
      if (isEdit) {
        await camerasApi.update(cameraId, payload);
        toast.success(`Camera "${payload.name}" updated.`);
        navigate(`/cameras/${cameraId}`);
      } else {
        const created = await camerasApi.create(payload);
        toast.success(`Camera "${created.name}" registered.`);
        navigate(`/cameras/${created.camera_id}`);
      }
    } catch (err) {
      setSubmitError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  if (isEdit && loading && !camera) return <Loading label="Loading camera…" />;
  if (isEdit && loadError) return <ErrorState error={loadError} onRetry={refresh} />;

  return (
    <Box>
      <Button
        startIcon={<ArrowBackIcon />}
        onClick={() => navigate(isEdit ? `/cameras/${cameraId}` : "/cameras")}
        sx={{ mb: 2 }}
      >
        Back
      </Button>

      <PageHeader
        title={isEdit ? `Edit ${camera?.name || "camera"}` : "Register a camera"}
        subtitle={
          isEdit
            ? "A running worker is restarted when you save, so changes take effect at once."
            : "An enabled camera starts watching for fire and smoke as soon as it is saved."
        }
      />

      <Box component="form" onSubmit={submit} noValidate>
        <Grid container spacing={2}>
          <Grid size={{ xs: 12, lg: 7 }}>
            <Card>
              <CardContent>
                <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 2 }}>
                  Source
                </Typography>
                <Stack spacing={2.5}>
                  <TextField
                    label="Name"
                    value={values.name}
                    onChange={setField("name")}
                    error={Boolean(errors.name)}
                    helperText={errors.name || "Must be unique within this workspace."}
                    required
                    fullWidth
                    autoFocus
                  />
                  <TextField
                    label="RTSP URL"
                    value={values.rtsp_url}
                    onChange={setField("rtsp_url")}
                    error={Boolean(errors.rtsp_url)}
                    helperText={
                      errors.rtsp_url ||
                      "rtsp://user:pass@host:554/stream, or a file path inside the API container for testing."
                    }
                    required
                    fullWidth
                    placeholder="rtsp://mediamtx:8554/fire1"
                  />
                  <Typography variant="subtitle2" sx={{ pt: 1 }}>
                    Where it looks
                  </Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ mt: "4px !important" }}>
                    Alerts read "Building - Floor n - Zone - Area", so responders know where to go.
                    Analytics can group cameras by any of them.
                  </Typography>
                  <Grid container spacing={2}>
                    {LOCATION_FIELDS.map(({ key, label, placeholder }) => (
                      <Grid key={key} size={{ xs: 12, sm: 6 }}>
                        <TextField
                          label={label}
                          value={values[key]}
                          onChange={setField(key)}
                          error={Boolean(errors[key])}
                          helperText={errors[key]}
                          placeholder={placeholder}
                          fullWidth
                        />
                      </Grid>
                    ))}
                  </Grid>
                  <TextField
                    label="Location"
                    value={values.location}
                    onChange={setField("location")}
                    error={Boolean(errors.location)}
                    helperText={
                      errors.location || "Free-form; used in alerts when the fields above are empty."
                    }
                    fullWidth
                    placeholder="North entrance, by the stairs"
                  />
                  <FormControlLabel
                    control={<Switch checked={values.enabled} onChange={setField("enabled")} />}
                    label="Enabled"
                  />
                </Stack>
              </CardContent>
            </Card>
          </Grid>

          <Grid size={{ xs: 12, lg: 5 }}>
            <Card>
              <CardContent>
                <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                  Detection
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 2 }}>
                  Leave a field blank to inherit the global value from the API's environment. A
                  blank is not zero.
                </Typography>
                <Divider sx={{ mb: 2 }} />
                <Stack direction="row" spacing={2} sx={{ mb: 1 }}>
                  <FormControlLabel
                    control={<Switch checked={values.kind_fire} onChange={setField("kind_fire")} />}
                    label="Alert on fire"
                  />
                  <FormControlLabel
                    control={<Switch checked={values.kind_smoke} onChange={setField("kind_smoke")} />}
                    label="Alert on smoke"
                  />
                </Stack>
                {errors.kinds ? (
                  <Alert severity="error" sx={{ mb: 2 }}>
                    {errors.kinds}
                  </Alert>
                ) : null}
                <Stack spacing={2.5} sx={{ mt: 1 }}>
                  {OVERRIDE_FIELDS.map(({ key, label, unit, help, step }) => (
                    <TextField
                      key={key}
                      label={label}
                      value={values[key]}
                      onChange={setField(key)}
                      error={Boolean(errors[key])}
                      helperText={errors[key] || help}
                      type="number"
                      fullWidth
                      slotProps={{
                        htmlInput: { step: step || 1 },
                        input: {
                          endAdornment: <InputAdornment position="end">{unit}</InputAdornment>,
                        },
                      }}
                    />
                  ))}
                </Stack>
              </CardContent>
            </Card>
          </Grid>

          <Grid size={12}>
            {submitError ? (
              <Alert severity="error" sx={{ mb: 2 }}>
                {submitError}
              </Alert>
            ) : null}
            <Stack direction="row" spacing={1}>
              <Button type="submit" variant="contained" disabled={saving}>
                {saving ? "Saving…" : isEdit ? "Save changes" : "Register camera"}
              </Button>
              <Button
                color="inherit"
                disabled={saving}
                onClick={() => navigate(isEdit ? `/cameras/${cameraId}` : "/cameras")}
              >
                Cancel
              </Button>
            </Stack>
          </Grid>
        </Grid>
      </Box>
    </Box>
  );
}
