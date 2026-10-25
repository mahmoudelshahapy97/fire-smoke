import { createContext, useContext, useMemo } from "react";
import { alerts as alertsApi } from "../api/endpoints";
import { usePolling } from "../hooks/usePolling";
import { ALERT_POLL_MS } from "../utils/constants";

/**
 * The unacknowledged alerts of the active workspace, polled once for the whole
 * console: the header badge and the emergency dialog read the same answer.
 * Mounted inside the workspace provider, so switching workspace re-polls.
 */
const AlertsContext = createContext({ count: 0, alerts: [], error: null, refresh: () => {} });

export function AlertsProvider({ workspaceId, children }) {
  const { data, error, refresh } = usePolling(({ signal }) => alertsApi.active({ signal }), {
    intervalMs: ALERT_POLL_MS,
    enabled: Boolean(workspaceId),
    deps: [workspaceId],
  });
  const value = useMemo(
    () => ({
      count: data?.count ?? 0,
      alerts: data?.alerts ?? [],
      error,
      refresh,
    }),
    [data, error, refresh]
  );
  return <AlertsContext.Provider value={value}>{children}</AlertsContext.Provider>;
}

export const useAlerts = () => useContext(AlertsContext);

export default AlertsProvider;
