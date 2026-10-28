import { AppShell, NotificationBell, NotificationsProvider } from "@insighteye/ui";
import { useTranslation } from "react-i18next";
import DashboardIcon from "@mui/icons-material/SpaceDashboard";
import VideocamIcon from "@mui/icons-material/Videocam";
import GridViewIcon from "@mui/icons-material/GridView";
import LocalFireDepartmentIcon from "@mui/icons-material/LocalFireDepartment";
import NotificationsIcon from "@mui/icons-material/Notifications";
import InsightsIcon from "@mui/icons-material/Insights";
import TuneIcon from "@mui/icons-material/Tune";
import GroupIcon from "@mui/icons-material/Group";
import WorkspacesIcon from "@mui/icons-material/Workspaces";
import HistoryIcon from "@mui/icons-material/History";

import EmergencyAlert, { AlertBadge } from "../components/EmergencyAlert";
import AlertsProvider, { useAlerts } from "../alerts/AlertsContext";
import { useWorkspace } from "../workspace/WorkspaceContext";

/**
 * Fire is the one alarm that must not wait for someone to look at the bell:
 * the emergency dialog (EmergencyAlert) stays on top of every page until an
 * open alert is acknowledged, and the flame badge counts what is still open.
 * Everything else (camera health, tests) arrives through the shared bell.
 */
function Shell() {
  const { t } = useTranslation();
  const workspace = useWorkspace();
  const { count } = useAlerts();

  const navSections = [
    {
      heading: t("shell.monitor"),
      items: [
        { to: "/", label: t("nav.dashboard"), icon: <DashboardIcon />, end: true, perm: "viewer" },
        { to: "/cameras", label: t("nav.cameras"), icon: <VideocamIcon />, perm: "viewer" },
        { to: "/live", label: t("nav.liveWall"), icon: <GridViewIcon />, perm: "viewer" },
        { to: "/events", label: t("layout.incidents"), icon: <LocalFireDepartmentIcon />, perm: "viewer", badge: "openAlerts" },
        { to: "/notifications", label: t("nav.notifications"), icon: <NotificationsIcon />, perm: "viewer" },
        { to: "/analytics", label: t("nav.analytics"), icon: <InsightsIcon />, perm: "viewer" },
      ],
    },
    {
      heading: t("shell.system"),
      items: [
        { to: "/system", label: t("nav.system"), icon: <TuneIcon />, perm: "viewer" },
        { to: "/workspaces", label: t("nav.workspaces"), icon: <WorkspacesIcon />, perm: "admin" },
        { to: "/users", label: t("nav.users"), icon: <GroupIcon />, perm: "admin" },
        { to: "/audit", label: t("nav.audit"), icon: <HistoryIcon />, perm: "admin" },
      ],
    },
  ];

  return (
    <>
      <AppShell
        product={{ brand: "InsightEye", tagline: t("product.tagline"), icon: <LocalFireDepartmentIcon /> }}
        navSections={navSections}
        badges={{ openAlerts: count }}
        topBarExtras={
          <>
            {workspace.active && <AlertBadge />}
            <NotificationBell />
          </>
        }
      />
      {workspace.active && <EmergencyAlert />}
    </>
  );
}

export function AppLayout() {
  const workspace = useWorkspace();
  return (
    <NotificationsProvider>
      <AlertsProvider workspaceId={workspace.active?.workspace_id}>
        <Shell />
      </AlertsProvider>
    </NotificationsProvider>
  );
}

export default AppLayout;
