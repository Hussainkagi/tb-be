const AttendanceModel = require("../models/attendanceModel");
const EmployeeModel = require("../models/employeeModel");
const BranchModel = require("../models/branchModel");
const ShiftModel = require("../models/shiftModel");
const { uploadCheckInSelfie, uploadCheckOutSelfie } = require("../utils/cloudinaryHelper");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Haversine formula — returns distance in metres between two coordinates.
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3;
    const toRad = (deg) => (deg * Math.PI) / 180;
    const φ1 = toRad(lat1);
    const φ2 = toRad(lat2);
    const Δφ = toRad(lat2 - lat1);
    const Δλ = toRad(lon2 - lon1);

    const a =
        Math.sin(Δφ / 2) ** 2 +
        Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;

    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Returns true when the employee's coordinates fall within the branch's
 * attendance_radius.
 */
function isWithinRadius(empLat, empLon, branchLat, branchLon, radius) {
    const distance = Math.round(calculateDistance(empLat, empLon, branchLat, branchLon));
    return { withinRadius: distance <= radius, distance };
}

/**
 * Convert a Date or "HH:mm" string to total minutes since midnight,
 * evaluated in the given IANA timezone.
 */
function toMinutes(value, timezone) {
    if (value instanceof Date) {
        const formatter = new Intl.DateTimeFormat("en-US", {
            timeZone: timezone,
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
        });
        const parts = formatter.formatToParts(value);
        const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
        const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
        return h * 60 + m;
    }
    // "HH:mm" string
    const [h, m] = value.split(":").map(Number);
    return h * 60 + m;
}

/**
 * Returns "before-time" | "on-time" | "late" based on shift timing.
 */
function calculateAttendanceStatus(checkInTime, shift, timezone) {
    const checkInMinutes = toMinutes(checkInTime, timezone);
    const startMinutes = toMinutes(shift.start_time);
    const lateMinutes = startMinutes + (shift.late_grace_minutes ?? 0);

    if (checkInMinutes < startMinutes) return "before-time";
    if (checkInMinutes <= lateMinutes) return "on-time";
    return "late";
}

/**
 * Returns today's calendar date as "YYYY-MM-DD" evaluated in the given
 * IANA timezone.
 */
function getTodayInTimezone(timezone) {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(new Date());
}

/**
 * Format a JS Date as "HH:MM:SS AM/PM" in the given timezone.
 */
function formatTime(date, timezone) {
    if (!date) return null;
    const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: true,
    });
    const parts = formatter.formatToParts(date);
    const get = (type) => parts.find((p) => p.type === type)?.value ?? "00";
    return `${get("hour")}:${get("minute")}:${get("second")} ${get("dayPeriod")}`;
}

// ---------------------------------------------------------------------------
// Internal — upload a selfie file to Cloudinary, return { path, url }.
// Returns { path: null, url: null } when no file is provided so callers
// never have to null-check.
// ---------------------------------------------------------------------------
async function _uploadSelfie(fileBuffer, employeeId, type = "check-in") {
    if (!fileBuffer) return { path: null, url: null };

    const upload =
        type === "check-out"
            ? await uploadCheckOutSelfie(fileBuffer, employeeId)
            : await uploadCheckInSelfie(fileBuffer, employeeId);

    // publicId works as the "path" stored in the DB for later reference /
    // deletion. secureUrl is the CDN URL shown to clients.
    return { path: upload.publicId, url: upload.secureUrl };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const AttendanceService = {

    // -----------------------------------------------------------------------
    // CHECK-IN
    // -----------------------------------------------------------------------
    /**
     * @param {string|number} user_id
     * @param {string|number} company_id
     * @param {object}        payload
     * @param {number}        payload.latitude
     * @param {number}        payload.longitude
     * @param {string}        [payload.address]
     * @param {Buffer}        [payload.selfie_file]  ← raw file buffer from multer / busboy
     */
    async checkIn(user_id, company_id, payload) {
        try {
            const { latitude, longitude, address = null, selfie_file = null } = payload;

            // 1. Resolve employee from logged-in user + company
            const employee = await EmployeeModel.findByUserAndCompany(user_id, company_id);
            if (!employee) {
                return { success: false, message: "Employee profile not found for this company" };
            }
            const employee_id = employee.id;

            // 2. Load branch (carries geofence data)
            const branch = await BranchModel.findById(employee.branch_id);
            if (!branch) {
                return { success: false, message: "Branch not found for this employee" };
            }

            // 3. Load shift (carries timing + timezone)
            const shift = await ShiftModel.findById(employee.shift_id);
            if (!shift) {
                return { success: false, message: "Shift not found for this employee" };
            }

            const timezone = shift.timezone ?? "UTC";


            // 4. Check if today is a company off day (shift weekday is false)
            const now = new Date();
            const weekday = now.toLocaleString("en-US", { weekday: "long", timeZone: timezone }).toLowerCase();
            if (shift[weekday] === false) {
                return {
                    success: false,
                    message: `Today is a company off day (${weekday.charAt(0).toUpperCase() + weekday.slice(1)}). Check-in is not allowed.`
                };
            }

            // 5. Geofence check (skip if remote job)
            if (!employee.is_remote_job) {
                if (branch.latitude == null || branch.longitude == null) {
                    return { success: false, message: "Branch location is not configured" };
                }

                const { withinRadius, distance } = isWithinRadius(
                    latitude,
                    longitude,
                    branch.latitude,
                    branch.longitude,
                    branch.attendance_radius,
                );

                if (!withinRadius) {
                    return {
                        success: false,
                        message: `You are outside the allowed radius. Your distance: ${distance}m, Allowed: ${branch.attendance_radius}m`,
                    };
                }
            }

            // 5. Resolve today's date in the shift's timezone
            const attendanceDate = getTodayInTimezone(timezone);

            // 6. Prevent duplicate check-in
            const existing = await AttendanceModel.findByEmployeeAndDate(employee_id, attendanceDate);
            if (existing?.check_in) {
                return { success: false, message: "You have already checked in today" };
            }

            // 7. Upload selfie to Cloudinary (non-blocking on failure — we still
            //    allow check-in even if image upload fails, just log the error)
            let selfie_path = null;
            let selfie_url = null;
            if (selfie_file) {
                try {
                    const uploaded = await _uploadSelfie(selfie_file, employee_id, "check-in");
                    selfie_path = uploaded.path;
                    selfie_url = uploaded.url;
                } catch (uploadErr) {
                    console.error("[CheckIn] Selfie upload failed:", uploadErr.message);
                }
            }

            // 8. Determine attendance status
            const checkInTime = new Date();
            const attendanceStatus = calculateAttendanceStatus(checkInTime, shift, timezone);

            // 9. Upsert the attendance row
            let record;
            if (existing) {
                // Row exists (pre-created as absent/week-off) — update it
                record = await AttendanceModel.checkIn(existing.id, {
                    check_in: checkInTime,
                    check_in_latitude: latitude,
                    check_in_longitude: longitude,
                    check_in_address: address,
                    check_in_selfie: selfie_path,
                    check_in_selfie_url: selfie_url,
                    attendance_status: attendanceStatus,
                    status: "checked-in",
                });
            } else {
                record = await AttendanceModel.create({
                    company_id: employee.company_id,
                    branch_id: employee.branch_id,
                    employee_id,
                    attendance_date: attendanceDate,
                    check_in: checkInTime,
                    check_in_latitude: latitude,
                    check_in_longitude: longitude,
                    check_in_address: address,
                    check_in_selfie: selfie_path,
                    check_in_selfie_url: selfie_url,
                    attendance_status: attendanceStatus,
                    status: "checked-in",
                });
            }

            return {
                success: true,
                message: "Checked in successfully",
                data: {
                    id: record.id,
                    attendance_date: record.attendance_date,
                    check_in: formatTime(record.check_in, timezone),
                    attendance_status: record.attendance_status,
                    status: record.status,
                    check_in_selfie_url: selfie_url,
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // -----------------------------------------------------------------------
    // CHECK-OUT
    // -----------------------------------------------------------------------
    /**
     * @param {string|number} user_id
     * @param {string|number} company_id
     * @param {object}        payload
     * @param {number}        payload.latitude
     * @param {number}        payload.longitude
     * @param {string}        [payload.address]
     * @param {Buffer}        [payload.selfie_file]  ← raw file buffer from multer / busboy
     */
    async checkOut(user_id, company_id, payload) {
        try {
            const { latitude, longitude, address = null, selfie_file = null } = payload;

            // 1. Resolve employee from logged-in user + company
            const employee = await EmployeeModel.findByUserAndCompany(user_id, company_id);
            if (!employee) {
                return { success: false, message: "Employee profile not found for this company" };
            }
            const employee_id = employee.id;

            // 2. Load branch
            const branch = await BranchModel.findById(employee.branch_id);
            if (!branch) {
                return { success: false, message: "Branch not found for this employee" };
            }

            // 3. Load shift
            const shift = await ShiftModel.findById(employee.shift_id);
            if (!shift) {
                return { success: false, message: "Shift not found for this employee" };
            }

            const timezone = shift.timezone ?? "UTC";


            // 4. Check if today is a company off day (shift weekday is false)
            const now = new Date();
            const weekday = now.toLocaleString("en-US", { weekday: "long", timeZone: timezone }).toLowerCase();
            if (shift[weekday] === false) {
                return {
                    success: false,
                    message: `Today is a company off day (${weekday.charAt(0).toUpperCase() + weekday.slice(1)}). Check-out is not allowed.`
                };
            }

            // 5. Geofence check (skip if remote job)
            if (!employee.is_remote_job) {
                if (branch.latitude == null || branch.longitude == null) {
                    return { success: false, message: "Branch location is not configured" };
                }

                const { withinRadius, distance } = isWithinRadius(
                    latitude,
                    longitude,
                    branch.latitude,
                    branch.longitude,
                    branch.attendance_radius,
                );

                if (!withinRadius) {
                    return {
                        success: false,
                        message: `You are outside the allowed radius. Your distance: ${distance}m, Allowed: ${branch.attendance_radius}m`,
                    };
                }
            }

            // 5. Resolve today's date in shift timezone
            const attendanceDate = getTodayInTimezone(timezone);

            // 6. Must have checked in first
            const record = await AttendanceModel.findByEmployeeAndDate(employee_id, attendanceDate);
            if (!record?.check_in) {
                return { success: false, message: "You must check in before checking out" };
            }

            // 7. Prevent duplicate check-out
            if (record.check_out) {
                return { success: false, message: "You have already checked out today" };
            }

            // 8. Upload selfie to Cloudinary
            let selfie_path = null;
            let selfie_url = null;
            if (selfie_file) {
                try {
                    const uploaded = await _uploadSelfie(selfie_file, employee_id, "check-out");
                    selfie_path = uploaded.path;
                    selfie_url = uploaded.url;
                } catch (uploadErr) {
                    console.error("[CheckOut] Selfie upload failed:", uploadErr.message);
                }
            }

            // 9. Calculate total hours
            const checkOutTime = new Date();
            const totalHours = parseFloat(
                ((checkOutTime - new Date(record.check_in)) / (1000 * 60 * 60)).toFixed(2)
            );

            // 10. Persist
            const updated = await AttendanceModel.checkOut(record.id, {
                check_out: checkOutTime,
                check_out_latitude: latitude,
                check_out_longitude: longitude,
                check_out_address: address,
                check_out_selfie: selfie_path,
                check_out_selfie_url: selfie_url,
                total_hours: totalHours,
                status: "checked-out",
            });

            return {
                success: true,
                message: "Checked out successfully",
                data: {
                    id: updated.id,
                    attendance_date: updated.attendance_date,
                    check_in: formatTime(new Date(updated.check_in), timezone),
                    check_out: formatTime(updated.check_out, timezone),
                    total_hours: updated.total_hours,
                    status: updated.status,
                    check_out_selfie_url: selfie_url,
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // -----------------------------------------------------------------------
    // READ
    // -----------------------------------------------------------------------

    async getAttendanceById(id) {
        try {
            const record = await AttendanceModel.findById(id);
            if (!record) {
                return { success: false, message: "Attendance record not found" };
            }
            return { success: true, data: record };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async getAttendanceByCompany(company_id, filters = {}) {
        try {
            const records = await AttendanceModel.findByCompany(company_id, filters);
            return { success: true, data: records };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async getAttendanceByEmployee(company_id, employee_id, filters = {}) {
        try {
            const records = await AttendanceModel.findByEmployee(company_id, employee_id, filters);
            return { success: true, data: records };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async getAttendanceByBranch(branch_id, filters = {}) {
        try {
            const records = await AttendanceModel.findByBranch(branch_id, filters);
            return { success: true, data: records };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async getCheckInLocations(company_id, filters = {}) {
        try {
            const records = await AttendanceModel.findCheckInLocations(company_id, filters);
            return { success: true, data: records };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // -----------------------------------------------------------------------
    // SUMMARY  (present / absent / late counts for a date range)
    // -----------------------------------------------------------------------

    async getAttendanceSummary(company_id, filters = {}) {
        try {
            const records = await AttendanceModel.findByCompany(company_id, filters);

            const summary = {
                total: records.length,
                present: 0,
                absent: 0,
                late: 0,
                on_time: 0,
                before_time: 0,
                comp_off: 0,
                week_off: 0,
                leave: 0,
                holiday: 0,
                total_hours: 0,
            };

            for (const r of records) {
                if (r.status === "checked-in" || r.status === "checked-out") summary.present++;
                if (r.status === "absent") summary.absent++;
                if (r.status === "comp-off") summary.comp_off++;
                if (r.status === "week-off") summary.week_off++;
                if (r.status === "leave") summary.leave++;
                if (r.status === "holiday") summary.holiday++;
                if (r.attendance_status === "late") summary.late++;
                if (r.attendance_status === "on-time") summary.on_time++;
                if (r.attendance_status === "before-time") summary.before_time++;
                if (r.total_hours) summary.total_hours += Number(r.total_hours);
            }

            summary.total_hours = parseFloat(summary.total_hours.toFixed(2));
            summary.average_hours =
                summary.present > 0
                    ? parseFloat((summary.total_hours / summary.present).toFixed(2))
                    : 0;

            return { success: true, data: summary };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // -----------------------------------------------------------------------
    // ADMIN — manual update (remarks, status override, etc.)
    // -----------------------------------------------------------------------

    async updateAttendance(id, data) {
        try {
            // Guard immutable fields
            delete data.company_id;
            delete data.employee_id;
            delete data.attendance_date;

            const record = await AttendanceModel.findById(id);
            if (!record) {
                return { success: false, message: "Attendance record not found" };
            }

            if (data.status) {
                const VALID_STATUSES = [
                    "checked-in", "checked-out", "absent",
                    "leave", "holiday", "week-off", "comp-off",
                ];
                if (!VALID_STATUSES.includes(data.status)) {
                    return {
                        success: false,
                        message: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}`,
                    };
                }
            }

            if (data.attendance_status) {
                const VALID_ATT_STATUSES = ["on-time", "before-time", "late"];
                if (!VALID_ATT_STATUSES.includes(data.attendance_status)) {
                    return {
                        success: false,
                        message: `Invalid attendance_status. Must be one of: ${VALID_ATT_STATUSES.join(", ")}`,
                    };
                }
            }

            const updated = await AttendanceModel.update(id, data);
            return {
                success: true,
                message: "Attendance record updated successfully",
                data: updated,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async deleteAttendance(id) {
        try {
            const record = await AttendanceModel.delete(id);
            if (!record) {
                return { success: false, message: "Attendance record not found" };
            }
            return { success: true, message: "Attendance record deleted successfully", data: record };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },
};

module.exports = AttendanceService;