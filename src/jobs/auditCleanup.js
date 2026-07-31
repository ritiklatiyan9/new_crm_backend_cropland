// Scheduled job: purge audit (activity) logs older than the retention window.
// Runs once on startup, then daily. Default retention is 7 days (AUDIT_RETENTION_DAYS).

import { query } from '../db/index.js';

const RETENTION_DAYS = Number(process.env.AUDIT_RETENTION_DAYS || 7);
const DAY_MS = 24 * 60 * 60 * 1000;

/** Delete activity_logs older than `days` days. Returns the number removed. */
export async function purgeOldAuditLogs(days = RETENTION_DAYS) {
  const { rowCount } = await query(
    `DELETE FROM activity_logs WHERE created_at < now() - ($1 || ' days')::interval`,
    [days],
  );
  return rowCount;
}

/** Start the daily audit-log cleanup. Returns a stop() function. */
export function startAuditCleanup(app) {
  const run = async () => {
    try {
      const removed = await purgeOldAuditLogs();
      if (removed) app.log.info(`audit cleanup: removed ${removed} log(s) older than ${RETENTION_DAYS} days`);
    } catch (err) {
      app.log.error({ err }, 'audit cleanup failed');
    }
  };
  run(); // sweep immediately on boot
  const timer = setInterval(run, DAY_MS);
  timer.unref?.(); // don't keep the process alive just for this
  return () => clearInterval(timer);
}
