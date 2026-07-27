-- Migration: prevent duplicate attendance check-in/check-out reminders
--
-- attendanceReminderJob previously had no idempotency guard: every time it
-- ran for a given day it created a brand-new `notifications` row per
-- employee, each independently fanned out and pushed. If the job (or the
-- process hosting it) ran more than once for the same target day —
-- restart, redeploy, multiple instances — employees received duplicate
-- push notifications for the same check-in/check-out event.
--
-- attendance reminders are now tagged with entity_type = 'attendance_reminder'
-- and entity_id = employee id (see notificationService.scheduleAttendanceReminders).
-- This unique index makes "one checkin reminder + one checkout reminder per
-- employee per day" an atomic DB-level guarantee, so scheduling is safe to
-- call more than once — the job now catches the resulting unique-violation
-- and treats it as "already scheduled" instead of creating a duplicate.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS uq_attendance_reminder_once_per_day
    ON notifications (notification_type, entity_id, (scheduled_at::date))
    WHERE entity_type = 'attendance_reminder'
      AND deleted_at IS NULL;

COMMIT;
