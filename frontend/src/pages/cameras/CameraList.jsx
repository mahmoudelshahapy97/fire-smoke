import { useState } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import IconButton from "@mui/material/IconButton";
import Link from "@mui/material/Link";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";

import AddIcon from "@mui/icons-material/Add";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import EditIcon from "@mui/icons-material/Edit";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import RefreshIcon from "@mui/icons-material/Refresh";
import StopIcon from "@mui/icons-material/Stop";
import VideocamIcon from "@mui/icons-material/Videocam";

import ConfirmDialog from "../../components/ConfirmDialog";
import PageHeader from "../../components/PageHeader";
import { EmptyState, ErrorState, Loading } from "../../components/DataStates";
import { EnabledChip, LiveStatusChip, WorkerChip } from "../../components/StatusChips";
import { useToast } from "../../components/Toast";
import { errorMessage } from "../../api/client";
import { cameras as cameraApi, system } from "../../api/endpoints";
import { useAuth } from "../../auth/AuthContext";
import { useAsync } from "../../hooks/useAsync";
import { usePolling } from "../../hooks/usePolling";
import { POLL_INTERVAL_MS } from "../../utils/constants";
import { cameraPlace, formatDateTime, redactUrl } from "../../utils/format";

export default function CameraList() {
  const navigate = useNavigate();
  const toast = useToast();
  const { hasRole } = useAuth();
  const canOperate = hasRole("operator");
  const canManage = hasRole("admin");

  const { data, error, loading, refresh } = useAsync(
    ({ signal }) => cameraApi.list(undefined, { signal }),
    []
  );

  // Worker state lives in the stream manager, not in the camera row, so
  // "is it actually running" has to come from the system endpoint.
  const workers = usePolling(({ signal }) => system.workers({ signal }), {
    intervalMs: POLL_INTERVAL_MS * 3,
  });

  const [pendingDelete, setPendingDelete] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const workerFor = (cameraId) =>
    (workers.data?.data?.workers || []).find((worker) => worker.camera_id === cameraId);

  const runAction = async (cameraId, action, successMessage) => {
    setBusyId(cameraId);
    try {
      await action();
      toast.success(successMessage);
      refresh();
      workers.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const confirmDelete = async () => {
    const camera = pendingDelete;
    setPendingDelete(null);
    await runAction(
      camera.camera_id,
      () => cameraApi.remove(camera.camera_id),
      `Camera "${camera.name}" deleted.`
    );
  };

  const rows = data || [];

  return (
    <Box>
      <PageHeader
        title="Cameras"
        subtitle="RTSP sources being watched for fire and smoke."
        actions={[
          canManage && (
            <Button
              key="add"
              component={RouterLink}
              to="/cameras/new"
              variant="contained"
              startIcon={<AddIcon />}
            >
              Add camera
            </Button>
          ),
          <Button key="refresh" onClick={refresh} startIcon={<RefreshIcon />}>
            Refresh
          </Button>,
        ]}
      />

      <ErrorState error={error} onRetry={refresh} />

      {loading && !data ? (
        <Loading label="Loading cameras…" />
      ) : rows.length ? (
        <Card>
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Name</TableCell>
                  <TableCell>Location</TableCell>
                  <TableCell>Source</TableCell>
                  <TableCell>State</TableCell>
                  <TableCell>Worker</TableCell>
                  <TableCell>Added</TableCell>
                  <TableCell align="right">Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((camera) => {
                  const worker = workerFor(camera.camera_id);
                  const busy = busyId === camera.camera_id;
                  return (
                    <TableRow key={camera.camera_id} hover>
                      <TableCell>
                        <Link
                          component={RouterLink}
                          to={`/cameras/${camera.camera_id}`}
                          underline="hover"
                          sx={{ fontWeight: 600 }}
                        >
                          {camera.name}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2" color="text.secondary">
                          {cameraPlace(camera)}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Tooltip title={redactUrl(camera.rtsp_url)}>
                          <Typography
                            variant="caption"
                            color="text.disabled"
                            sx={{
                              display: "block",
                              maxWidth: 220,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {redactUrl(camera.rtsp_url)}
                          </Typography>
                        </Tooltip>
                      </TableCell>
                      <TableCell>
                        <EnabledChip enabled={camera.enabled} />
                      </TableCell>
                      <TableCell>
                        <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                          <WorkerChip worker={worker} />
                          {worker?.running ? <LiveStatusChip status={worker.status} /> : null}
                        </Stack>
                      </TableCell>
                      <TableCell>
                        <Typography variant="caption" color="text.disabled">
                          {formatDateTime(camera.created_at)}
                        </Typography>
                      </TableCell>
                      <TableCell align="right">
                        <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                          {canOperate &&
                            (worker?.running ? (
                              <Tooltip title="Stop worker">
                                <span>
                                  <IconButton
                                    size="small"
                                    disabled={busy}
                                    aria-label={`Stop ${camera.name}`}
                                    onClick={() =>
                                      runAction(
                                        camera.camera_id,
                                        () => cameraApi.stop(camera.camera_id),
                                        "Worker stopped."
                                      )
                                    }
                                  >
                                    <StopIcon fontSize="small" />
                                  </IconButton>
                                </span>
                              </Tooltip>
                            ) : (
                              <Tooltip title="Start worker">
                                <span>
                                  <IconButton
                                    size="small"
                                    disabled={busy}
                                    aria-label={`Start ${camera.name}`}
                                    onClick={() =>
                                      runAction(
                                        camera.camera_id,
                                        () => cameraApi.start(camera.camera_id),
                                        "Worker started."
                                      )
                                    }
                                  >
                                    <PlayArrowIcon fontSize="small" />
                                  </IconButton>
                                </span>
                              </Tooltip>
                            ))}
                          {canManage && (
                            <Tooltip title="Edit">
                              <span>
                                <IconButton
                                  size="small"
                                  disabled={busy}
                                  aria-label={`Edit ${camera.name}`}
                                  onClick={() => navigate(`/cameras/${camera.camera_id}/edit`)}
                                >
                                  <EditIcon fontSize="small" />
                                </IconButton>
                              </span>
                            </Tooltip>
                          )}
                          {canManage && (
                            <Tooltip title="Delete">
                              <span>
                                <IconButton
                                  size="small"
                                  color="error"
                                  disabled={busy}
                                  aria-label={`Delete ${camera.name}`}
                                  onClick={() => setPendingDelete(camera)}
                                >
                                  <DeleteOutlineIcon fontSize="small" />
                                </IconButton>
                              </span>
                            </Tooltip>
                          )}
                        </Stack>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        </Card>
      ) : (
        <Card>
          <EmptyState
            title="No cameras registered"
            description="Add an RTSP source and a detection worker will start watching it for fire and smoke."
            icon={<VideocamIcon fontSize="inherit" />}
            action={
              canManage && (
                <Button
                  component={RouterLink}
                  to="/cameras/new"
                  variant="contained"
                  startIcon={<AddIcon />}
                >
                  Add camera
                </Button>
              )
            }
          />
        </Card>
      )}

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title={`Delete “${pendingDelete?.name}”?`}
        description="This also deletes every incident this camera raised, with its frames and clips."
        confirmLabel="Delete"
        confirmColor="error"
        onConfirm={confirmDelete}
        onClose={() => setPendingDelete(null)}
      />
    </Box>
  );
}
