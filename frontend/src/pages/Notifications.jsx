import { NotificationsPage } from "@insighteye/ui";

/** The kinds this backend raises (app/services/inbox_service.py callers). */
const KINDS = ["alert", "camera_offline", "camera_online", "system"];

export default function Notifications() {
  return <NotificationsPage kinds={KINDS} />;
}
