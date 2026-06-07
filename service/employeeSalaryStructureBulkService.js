const XLSX = require("xlsx");
const { parse } = require("csv-parse/sync");
const EmployeeSalaryStructureModel = require("../models/employeeSalaryStructureModel");
const EmployeeModel = require("../models/employeeModel");

const REQUIRED_COLUMNS = [
    "employee_id",
    "company_id",
    "effective_from",
    "actual_salary",
];

const OPTIONAL_COLUMNS = [
    "housing_allowance",
    "transport_allowance",
    "other_allowance",
    "effective_to",
    "overtime_enabled",
    "overtime_rate_per_hour",
    "payment_type",
];

const ALL_COLUMNS = [...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS];

/**
 * Parse uploaded file buffer into an array of row objects.
 * Supports .csv and .xlsx / .xls.
 */
function parseFile(buffer, mimetype, originalname) {
    const ext = originalname.split(".").pop().toLowerCase();

    let rows;

    if (ext === "csv" || mimetype === "text/csv" || mimetype === "application/csv") {
        rows = parse(buffer.toString("utf8"), {
            columns: true,
            skip_empty_lines: true,
            trim: true,
        });
    } else if (
        ext === "xlsx" ||
        ext === "xls" ||
        mimetype === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
        mimetype === "application/vnd.ms-excel"
    ) {
        const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        rows = XLSX.utils.sheet_to_json(sheet, { defval: null, raw: false });
    } else {
        throw new Error("Unsupported file type. Please upload a .csv or .xlsx file.");
    }

    return rows;
}

/**
 * Coerce + validate a single row. Returns { data } or { error }.
 */
function validateRow(raw, rowIndex) {
    const errors = [];

    // Check required fields
    for (const col of REQUIRED_COLUMNS) {
        const val = raw[col];
        if (val === null || val === undefined || String(val).trim() === "") {
            errors.push(`Missing required field: ${col}`);
        }
    }

    if (errors.length) {
        return { error: errors.join("; ") };
    }

    // Coerce types
    const data = {
        employee_id: String(raw.employee_id).trim(),
        company_id: String(raw.company_id).trim(),
        effective_from: raw.effective_from instanceof Date
            ? raw.effective_from.toISOString().split("T")[0]
            : String(raw.effective_from).trim(),
        actual_salary: parseFloat(raw.actual_salary) || 0,
        housing_allowance: parseFloat(raw.housing_allowance) || 0,
        transport_allowance: parseFloat(raw.transport_allowance) || 0,
        other_allowance: parseFloat(raw.other_allowance) || 0,
    };

    // Optional fields
    if (raw.effective_to && String(raw.effective_to).trim() !== "") {
        data.effective_to = raw.effective_to instanceof Date
            ? raw.effective_to.toISOString().split("T")[0]
            : String(raw.effective_to).trim();
    }

    if (raw.overtime_enabled !== null && raw.overtime_enabled !== undefined) {
        const ov = String(raw.overtime_enabled).trim().toLowerCase();
        data.overtime_enabled = ov === "true" || ov === "1" || ov === "yes";
    }

    if (raw.overtime_rate_per_hour !== null && raw.overtime_rate_per_hour !== undefined) {
        const rate = parseFloat(raw.overtime_rate_per_hour);
        if (!isNaN(rate)) data.overtime_rate_per_hour = rate;
    }

    if (raw.payment_type && String(raw.payment_type).trim() !== "") {
        data.payment_type = String(raw.payment_type).trim().toLowerCase();
    }

    // Validate effective_from is a real date
    if (isNaN(Date.parse(data.effective_from))) {
        return { error: `Invalid effective_from date: "${raw.effective_from}"` };
    }

    // Validate numeric salaries are non-negative
    for (const field of ["actual_salary", "housing_allowance", "transport_allowance", "other_allowance"]) {
        if (data[field] < 0) {
            errors.push(`${field} cannot be negative`);
        }
    }

    if (errors.length) {
        return { error: errors.join("; ") };
    }

    return { data };
}

const EmployeeSalaryStructureBulkService = {

    /**
     * Process a bulk upload file buffer.
     *
     * @param {Buffer}  buffer       - Raw file bytes
     * @param {string}  mimetype     - MIME type from multer
     * @param {string}  originalname - Original filename (used to detect extension)
     * @param {string}  [requestingCompanyId] - If provided, rows with a different
     *                                           company_id are rejected for security.
     *
     * @returns {Object} { success, summary: { total, created, skipped }, results[], errors[] }
     */
    async bulkUpload(buffer, mimetype, originalname, requestingCompanyId = null) {
        let rows;
        try {
            rows = parseFile(buffer, mimetype, originalname);
        } catch (err) {
            return { success: false, message: err.message };
        }

        if (!rows || rows.length === 0) {
            return { success: false, message: "The uploaded file contains no data rows." };
        }

        const results = [];
        const errors = [];
        let created = 0;

        for (let i = 0; i < rows.length; i++) {
            const rowNum = i + 2; // 1-based + header row
            const { data, error } = validateRow(rows[i], i);

            if (error) {
                errors.push({ row: rowNum, employee_id: rows[i].employee_id ?? null, error });
                continue;
            }

            // Security: reject if caller is scoped to a different company
            if (requestingCompanyId && String(data.company_id) !== String(requestingCompanyId)) {
                errors.push({
                    row: rowNum,
                    employee_id: data.employee_id,
                    error: `company_id "${data.company_id}" does not match the authorised company.`,
                });
                continue;
            }

            try {
                // Verify employee exists and belongs to company
                const employee = await EmployeeModel.findById(data.employee_id);
                if (!employee) {
                    errors.push({ row: rowNum, employee_id: data.employee_id, error: "Employee not found." });
                    continue;
                }
                if (String(employee.company_id) !== String(data.company_id)) {
                    errors.push({
                        row: rowNum,
                        employee_id: data.employee_id,
                        error: "Employee does not belong to the specified company.",
                    });
                    continue;
                }

                // Deactivate existing active structure before inserting
                await EmployeeSalaryStructureModel.deactivateAllByEmployee(data.employee_id);

                const record = await EmployeeSalaryStructureModel.create({
                    ...data,
                    is_active: true,
                });

                results.push({ row: rowNum, employee_id: data.employee_id, id: record.id, status: "created" });
                created++;
            } catch (dbErr) {
                errors.push({ row: rowNum, employee_id: data.employee_id, error: dbErr.message });
            }
        }

        return {
            success: true,
            summary: {
                total: rows.length,
                created,
                skipped: errors.length,
            },
            results,
            errors,
        };
    },

    /**
     * Return a CSV template string (for a "Download Template" endpoint).
     */
    getCsvTemplate() {
        const header = ALL_COLUMNS.join(",");
        const example = [
            "EMP001", "COMP001", "2025-01-01", "5000",
            "1500", "500", "250",
            "", "false", "", "monthly",
        ].join(",");
        return `${header}\n${example}\n`;
    },
};

module.exports = EmployeeSalaryStructureBulkService;