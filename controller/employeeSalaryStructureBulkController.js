const multer = require("multer");
const EmployeeSalaryStructureBulkService = require("../service/employeeSalaryStructureBulkService");

// ─── Multer setup ────────────────────────────────────────────────────────────


// ─── Controller ──────────────────────────────────────────────────────────────
// ─── Controller ──────────────────────────────────────────────────────────────
const EmployeeSalaryStructureBulkController = {

    /**
     * POST /companies/:company_id/salary-structures/bulk-upload
     */
    async bulkUpload(req, res) {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: "No file uploaded. Send the file in a field named 'file'.",
            });
        }

        try {
            const { company_id } = req.params;

            const result = await EmployeeSalaryStructureBulkService.bulkUpload(
                req.file.buffer,
                req.file.mimetype,
                req.file.originalname,
                company_id ?? null,
            );

            if (!result.success) {
                return res.status(400).json(result);
            }

            const status = result.errors.length > 0 && result.summary.created > 0
                ? 207
                : result.summary.created > 0
                    ? 201
                    : 400;

            return res.status(status).json(result);
        } catch (err) {
            return res.status(500).json({
                success: false,
                message: "Server error during bulk upload.",
                error: err.message,
            });
        }
    },

    /**
     * GET /salary-structures/bulk-upload/template
     */
    downloadTemplate(_req, res) {
        try {
            const csv = EmployeeSalaryStructureBulkService.getCsvTemplate();
            res.setHeader("Content-Type", "text/csv");
            res.setHeader(
                "Content-Disposition",
                'attachment; filename="salary_structure_template.csv"',
            );
            return res.status(200).send(csv);
        } catch (err) {
            return res.status(500).json({
                success: false,
                message: "Could not generate template.",
                error: err.message,
            });
        }
    },
};

module.exports = EmployeeSalaryStructureBulkController;

module.exports = EmployeeSalaryStructureBulkController;