-- ============================================================
-- 57_employee_work_from_home_days.sql
-- Must run after 08_employee.sql
--
-- Fixed work-from-home weekdays per employee (e.g. Monday and Friday).
-- On those days check-in and check-out skip the geofence, so an employee
-- who always works from home on a Friday does not have to send an
-- attendance request (56_attendance_requests.sql) every week for HR to
-- approve.
--
-- Optional: an empty list (the default) changes nothing. Employees with
-- is_remote_job = TRUE already skip the geofence every day.
--
-- Stored as lowercase English weekday names, the same keys the shifts
-- table uses for its working-day columns (monday … sunday).
-- ============================================================

ALTER TABLE employees
    ADD COLUMN IF NOT EXISTS work_from_home_days TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE employees DROP CONSTRAINT IF EXISTS chk_employees_work_from_home_days;
ALTER TABLE employees
    ADD CONSTRAINT chk_employees_work_from_home_days CHECK (
        work_from_home_days <@ ARRAY[
            'monday', 'tuesday', 'wednesday', 'thursday',
            'friday', 'saturday', 'sunday'
        ]::TEXT[]
    );
