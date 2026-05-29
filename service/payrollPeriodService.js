const PayrollPeriodModel = require("../models/payrollPeriodModel");
const PayrollModel = require("../models/payrollModel");

const VALID_STATUSES = ["open", "processing", "completed", "locked"];

// Allowed transitions: what status can move to what
const STATUS_TRANSITIONS = {
    open: ["processing"],
    processing: ["completed", "open"],
    completed: ["locked"],
    locked: [],
};

const PayrollPeriodService = {

    async createPayrollPeriod(data) {
        try {
            const { company_id, period_name, start_date, end_date } = data;

            if (!company_id || !period_name || !start_date || !end_date) {
                return { success: false, message: "company_id, period_name, start_date, and end_date are required" };
            }

            if (new Date(end_date) <= new Date(start_date)) {
                return { success: false, message: "end_date must be after start_date" };
            }

            const existing = await PayrollPeriodModel.findByName(company_id, period_name);
            if (existing) {
                return { success: false, message: "A payroll period with this name already exists for the company" };
            }

            const overlapping = await PayrollPeriodModel.findOverlapping(company_id, start_date, end_date);
            if (overlapping) {
                return {
                    success: false,
                    message: `Date range overlaps with existing period "${overlapping.period_name}" (${overlapping.start_date} → ${overlapping.end_date})`,
                };
            }

            const result = await PayrollPeriodModel.create(data);
            return {
                success: true,
                message: "Payroll period created successfully",
                data: result,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async getPayrollPeriodById(id) {
        try {
            const result = await PayrollPeriodModel.findById(id);
            if (!result) {
                return { success: false, message: "Payroll period not found" };
            }
            return { success: true, data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async getPayrollPeriodsByCompany(company_id) {
        try {
            const result = await PayrollPeriodModel.getAllByCompany(company_id);
            return { success: true, data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async getPayrollPeriodsByStatus(company_id, status) {
        try {
            if (!VALID_STATUSES.includes(status)) {
                return { success: false, message: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}` };
            }

            const result = await PayrollPeriodModel.getAllByStatus(company_id, status);
            return { success: true, data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async getPayrollPeriodsByDateRange(company_id, start_date, end_date) {
        try {
            if (!start_date || !end_date) {
                return { success: false, message: "start_date and end_date are required" };
            }

            if (new Date(end_date) <= new Date(start_date)) {
                return { success: false, message: "end_date must be after start_date" };
            }

            const result = await PayrollPeriodModel.getByDateRange(company_id, start_date, end_date);
            return { success: true, data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async updatePayrollPeriod(id, data) {
        try {
            const period = await PayrollPeriodModel.findById(id);
            if (!period) {
                return { success: false, message: "Payroll period not found" };
            }

            if (period.status === "locked") {
                return { success: false, message: "Locked payroll periods cannot be modified" };
            }

            // These are managed via dedicated methods only
            delete data.status;
            delete data.company_id;
            delete data.processed_at;
            delete data.processed_by;

            if (data.start_date || data.end_date) {
                const start = new Date(data.start_date || period.start_date);
                const end = new Date(data.end_date || period.end_date);
                if (end <= start) {
                    return { success: false, message: "end_date must be after start_date" };
                }
            }

            if (data.period_name && data.period_name !== period.period_name) {
                const existing = await PayrollPeriodModel.findByName(period.company_id, data.period_name);
                if (existing) {
                    return { success: false, message: "A payroll period with this name already exists for the company" };
                }
            }

            const result = await PayrollPeriodModel.update(id, data);
            if (!result) {
                return { success: false, message: "Payroll period not found" };
            }
            return {
                success: true,
                message: "Payroll period updated successfully",
                data: result,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async updatePayrollPeriodStatus(id, status) {
        try {
            if (!VALID_STATUSES.includes(status)) {
                return { success: false, message: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}` };
            }

            const period = await PayrollPeriodModel.findById(id);
            if (!period) {
                return { success: false, message: "Payroll period not found" };
            }

            const allowed = STATUS_TRANSITIONS[period.status];
            if (!allowed.includes(status)) {
                return {
                    success: false,
                    message: `Cannot transition from '${period.status}' to '${status}'. Allowed: ${allowed.length ? allowed.join(", ") : "none"}`,
                };
            }

            const result = await PayrollPeriodModel.updateStatus(id, status);
            return {
                success: true,
                message: `Payroll period status updated to '${status}'`,
                data: result,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async markAsProcessed(id, processed_by) {
        try {
            if (!processed_by) {
                return { success: false, message: "processed_by (user_id) is required" };
            }

            const period = await PayrollPeriodModel.findById(id);
            if (!period) {
                return { success: false, message: "Payroll period not found" };
            }

            if (period.status !== "processing") {
                return { success: false, message: `Only periods in 'processing' status can be marked as completed. Current status: '${period.status}'` };
            }

            const result = await PayrollPeriodModel.markAsProcessed(id, processed_by);
            return {
                success: true,
                message: "Payroll period marked as completed",
                data: result,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async lockPayrollPeriod(id) {
        try {
            const period = await PayrollPeriodModel.findById(id);
            if (!period) {
                return { success: false, message: "Payroll period not found" };
            }

            if (period.status !== "completed") {
                return { success: false, message: `Only 'completed' periods can be locked. Current status: '${period.status}'` };
            }

            const result = await PayrollPeriodModel.lock(id);
            return {
                success: true,
                message: "Payroll period locked successfully",
                data: result,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async deletePayrollPeriod(id) {
        try {
            const period = await PayrollPeriodModel.findById(id);
            if (!period) {
                return { success: false, message: "Payroll period not found" };
            }

            if (["locked", "completed"].includes(period.status)) {
                return {
                    success: false,
                    message: `Cannot delete a period with status "${period.status}". Only open or processing periods can be deleted.`,
                };
            }

            const linkedPayrolls = await PayrollModel.countByPeriod(id);

            const result = await PayrollPeriodModel.delete(id);
            if (!result) {
                return { success: false, message: "Payroll period not found" };
            }
            return {
                success: true,
                message: `Payroll period deleted. ${linkedPayrolls} linked payroll(s) were also removed.`,
                data: result,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },
};

module.exports = PayrollPeriodService;