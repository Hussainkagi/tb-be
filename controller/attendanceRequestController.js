const AttendanceRequestService = require("../service/attendanceRequestService");

// Routes: /api/companies/:company_id/attendance/requests...
const AttendanceRequestController = {
    // POST /requests — multipart: request_type, latitude, longitude, reason, address?, selfie?
    async create(req, res) {
        try {
            const result = await AttendanceRequestService.create(req.user.user_id, req.params.company_id, {
                request_type: req.body.request_type,
                latitude: req.body.latitude,
                longitude: req.body.longitude,
                address: req.body.address ?? null,
                reason: req.body.reason,
                selfie_file: req.file?.buffer ?? null,
            });
            return res.status(result.success ? 201 : 400).json(result);
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    // GET /requests/mine — today's, for the app's "waiting for approval" state
    async listMine(req, res) {
        try {
            const result = await AttendanceRequestService.listMineToday(req.user.user_id, req.params.company_id);
            return res.status(result.success ? 200 : 400).json(result);
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    // GET /requests?status=pending|approved|rejected|all&branchId=&from=&to=
    async list(req, res) {
        try {
            const { status, branchId, from, to } = req.query;
            const result = await AttendanceRequestService.list(req.params.company_id, {
                status: status || "pending",
                branch_id: branchId || null,
                from: from || null,
                to: to || null,
            });
            return res.status(result.success ? 200 : 400).json(result);
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    // POST /requests/review — { ids: [...], action: approve | approve_half_day | reject, note? }
    async review(req, res) {
        try {
            const result = await AttendanceRequestService.review(req.params.company_id, req.user.user_id, {
                ids: req.body?.ids,
                action: req.body?.action,
                note: req.body?.note ?? null,
            });
            return res.status(result.success ? 200 : 400).json(result);
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },
};

module.exports = AttendanceRequestController;
