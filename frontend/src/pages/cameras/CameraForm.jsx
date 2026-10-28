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
import { useTranslation } from "react-i18next";
import i18n from "i18next";

const LOCATION_FIELDS = [
  { key: "building", get label() { return i18n.t("cameraForm.building"); }, get placeholder() { return i18n.t("cameraForm.phBuilding"); }, max: 100 },
  { key: "floor_level", get label() { return i18n.t("cameraForm.floor"); }, placeholder: "2", max: 20 },
  { key: "zone", get label() { return i18n.t("cameraForm.zone"); }, get placeholder() { return i18n.t("cameraForm.phZone"); }, max: 100 },
  { key: "area", get label() { return i18n.t("cameraForm.area"); }, get placeholder() { return i18n.t("cameraForm.phArea"); }, max: 100 },
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
    get label() { return i18n.t("cameraForm.fireConfidence"); },
    unit: "0-1",
    get help() { return i18n.t("cameraForm.aFireBoxNeedsAt"); },
    min: 0.05,
    max: 1,
    step: 0.05,
  },
  {
    key: "smoke_confidence",
    get label() { return i18n.t("cameraForm.smokeConfidence"); },
    unit: "0-1",
    get help() { return i18n.t("cameraForm.theSameForSmokeLower"); },
    min: 0.05,
    max: 1,
    step: 0.05,
  },
  {
    key: "confirm_hits",
    get label() { return i18n.t("cameraForm.confirmAfter"); },
    unit: "checks",
    get help() { return i18n.t("cameraForm.sightingsNeededWithinTheWindow"); },
    min: 1,
    max: 30,
  },
  {
    key: "confirm_window",
    get label() { return i18n.t("cameraForm.outOfTheLast"); },
    unit: "checks",
    get help() { return i18n.t("cameraForm.theDetectorChecksAboutTwice"); },
    min: 1,
    max: 30,
  },
  {
    key: "clear_after_s",
    get label() { return i18n.t("cameraForm.clearAfter"); },
    unit: "s",
    get help() { return i18n.t("cameraForm.anIncidentClosesOnceNothing"); },
    min: 1,
    max: 3600,
  },
  {
    key: "cooldown_s",
    get label() { return i18n.t("cameraForm.cooldown"); },
    unit: "s",
    get help() { return i18n.t("cameraForm.seenAgainWithinThisLong"); },
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
  if (!values.name.trim()) errors.name = i18n.t("cameraForm.required");
  else if (values.name.length > 120) errors.name = i18n.t("cameraForm.atMost120Characters");

  if (!values.rtsp_url.trim()) errors.rtsp_url = i18n.t("cameraForm.required");
  if (values.location.length > 200) errors.location = i18n.t("cameraForm.atMost200Characters");
  LOCATION_FIELDS.forEach(({ key, max }) => {
    if (values[key].length > max) errors[key] = i18n.t("cameraForm.atMostMaxCharacters", { max });
  });

  OVERRIDE_FIELDS.forEach(({ key, min, max }) => {
    const raw = values[key];
    if (raw === "" || raw === null || raw === undefined) return;
    const value = Number(raw);
    if (Number.isNaN(value)) errors[key] = i18n.t("cameraForm.mustBeANumber");
    else if (value < min || value > max) errors[key] = i18n.t("cameraForm.betweenMinAndMax", { min, max });
  });

  // The backend clamps hits to the window, but asking for 6 of 5 is a typo
  // worth catching here.
  const hits = values.confirm_hits === "" ? null : Number(values.confirm_hits);
  const window = values.confirm_window === "" ? null : Number(values.confirm_window);
  if (hits !== null && window !== null && hits > window) {
    errors.confirm_hits = i18n.t("cameraForm.cannotExceedTheWindow");
  }
  if (!values.kind_fire && !values.kind_smoke) {
    errors.kinds = i18n.t("cameraForm.alertOnAtLeastOne");
  }

  return errors;
}

export default function CameraForm() {
  const { t } = useTranslation();
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
        toast.success(t("cameraForm.cameraNameUpdated", { name: payload.name }));
        navigate(`/cameras/${cameraId}`);
      } else {
        const created = await camerasApi.create(payload);
        toast.success(t("cameraForm.cameraNameRegistered", { name: created.name }));
        navigate(`/cameras/${created.camera_id}`);
      }
    } catch (err) {
      setSubmitError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  if (isEdit && loading && !camera) return <Loading label={t("cameraForm.loadingCamera")} />;
  if (isEdit && loadError) return <ErrorState error={loadError} onRetry={refresh} />;

  return (
    <Box>
      <Button
        startIcon={<ArrowBackIcon />}
        onClick={() => navigate(isEdit ? `/cameras/${cameraId}` : "/cameras")}
        sx={{ mb: 2 }}
      >
        {t("cameraForm.back")}
      </Button>

      <PageHeader
        title={isEdit ? t("cameraForm.editV0", { v0: camera?.name || "camera" }) : t("cameraForm.registerACamera")}
        subtitle={
          isEdit
            ? t("cameraForm.aRunningWorkerIsRestarted")
            : t("cameraForm.anEnabledCameraStartsWatching")
        }
      />

      <Box component="form" onSubmit={submit} noValidate>
        <Grid container spacing={2}>
          <Grid size={{ xs: 12, lg: 7 }}>
            <Card>
              <CardContent>
                <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 2 }}>
                  {t("cameraForm.source")}
                </Typography>
                <Stack spacing={2.5}>
                  <TextField
                    label={t("cameraForm.name")}
                    value={values.name}
                    onChange={setField("name")}
                    error={Boolean(errors.name)}
                    helperText={errors.name || t("cameraForm.mustBeUniqueWithinThis")}
                    required
                    fullWidth
                    autoFocus
                  />
                  <TextField
                    label={t("cameraForm.rtspUrl")}
                    value={values.rtsp_url}
                    onChange={setField("rtsp_url")}
                    error={Boolean(errors.rtsp_url)}
                    helperText={
                      errors.rtsp_url ||
                      t("cameraForm.rtspUserPassHost554")
                    }
                    required
                    fullWidth
                    placeholder={t("cameraForm.rtspMediamtx8554Fire1")}
                  />
                  <Typography variant="subtitle2" sx={{ pt: 1 }}>
                    {t("cameraForm.whereItLooks")}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ mt: "4px !important" }}>
                    {t("cameraForm.alertsReadBuildingFloorN")}
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
                    label={t("cameraForm.location")}
                    value={values.location}
                    onChange={setField("location")}
                    error={Boolean(errors.location)}
                    helperText={
                      errors.location || t("cameraForm.freeFormUsedInAlerts")
                    }
                    fullWidth
                    placeholder={t("cameraForm.northEntranceByTheStairs")}
                  />
                  <FormControlLabel
                    control={<Switch checked={values.enabled} onChange={setField("enabled")} />}
                    label={t("cameraForm.enabled")}
                  />
                </Stack>
              </CardContent>
            </Card>
          </Grid>

          <Grid size={{ xs: 12, lg: 5 }}>
            <Card>
              <CardContent>
                <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                  {t("cameraForm.detection")}
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 2 }}>
                  {t("cameraForm.leaveAFieldBlankTo")}
                </Typography>
                <Divider sx={{ mb: 2 }} />
                <Stack direction="row" spacing={2} sx={{ mb: 1 }}>
                  <FormControlLabel
                    control={<Switch checked={values.kind_fire} onChange={setField("kind_fire")} />}
                    label={t("cameraForm.alertOnFire")}
                  />
                  <FormControlLabel
                    control={<Switch checked={values.kind_smoke} onChange={setField("kind_smoke")} />}
                    label={t("cameraForm.alertOnSmoke")}
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
                {saving ? t("cameraForm.saving") : isEdit ? t("cameraForm.saveChanges") : t("cameraForm.registerCamera")}
              </Button>
              <Button
                color="inherit"
                disabled={saving}
                onClick={() => navigate(isEdit ? `/cameras/${cameraId}` : "/cameras")}
              >
                {t("cameraForm.cancel")}
              </Button>
            </Stack>
          </Grid>
        </Grid>
      </Box>
    </Box>
  );
}
