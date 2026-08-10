const PayslipModel = require("../models/payslipModel");
const PayrollModel = require("../models/payrollModel");
const PayrollAdjustmentModel = require("../models/payrollAdjustmentModel");

const PayrollPeriodModel = require("../models/payrollPeriodModel");
const { sendEmail } = require("../utils/mailer");
const { payslipTemplate } = require("../utils/emailTemplates");
const NotificationService = require("./notificationService");

// ============================================================
// UTILITY: Generate unique payslip number
// Format: PSL-{YYYYMM}-{EMPLOYEE_CODE}-{RANDOM4}
// ============================================================
function generatePayslipNumber(employee_code, periodStart) {
    const date = new Date(periodStart);
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
    const code = (employee_code || "EMP").replace(/\s+/g, "").toUpperCase();
    return `PSL-${yyyy}${mm}-${code}-${rand}`;
}

// ============================================================
// UTILITY: Shape a payslip for display
//
// Splits adjustments into earnings and deductions and totals each
// side, so every surface that renders a payslip — the web view, the
// mobile app, the emailed copy — shows the same itemised figures
// instead of each one re-deriving them.
// ============================================================
const EARNING_TYPES = ["bonus", "commission"];

function shapePayslip(payslip, adjustments = []) {
    const num = (v) => parseFloat(v) || 0;

    const earnings = adjustments.filter((a) => EARNING_TYPES.includes(a.adjustment_type));
    const deductions = adjustments.filter((a) => !EARNING_TYPES.includes(a.adjustment_type));

    const sum = (items) => parseFloat(items.reduce((t, a) => t + num(a.amount), 0).toFixed(2));

    const earningsTotal = sum(earnings);
    const deductionsTotal = sum(deductions);

    return {
        ...payslip,
        adjustments,
        breakdown: {
            earnings: [
                { label: "Gross salary", amount: num(payslip.gross_salary), type: "base" },
                ...(num(payslip.overtime_amount) > 0
                    ? [{
                        label: "Overtime",
                        amount: num(payslip.overtime_amount),
                        type: "overtime",
                        note: `${num(payslip.overtime_hours).toFixed(2)} hours`,
                    }]
                    : []),
                ...earnings.map((a) => ({
                    label: a.title,
                    amount: num(a.amount),
                    type: a.adjustment_type,
                    note: a.remarks || null,
                    adjustment_id: a.id,
                })),
            ],
            deductions: [
                ...(num(payslip.base_deduction_amount) > 0
                    ? [{
                        label: "Attendance & leave",
                        amount: num(payslip.base_deduction_amount),
                        type: "attendance",
                        note: "Absences, unpaid leave and half days",
                    }]
                    : []),
                ...(num(payslip.tax_amount) > 0
                    ? [{ label: "Tax", amount: num(payslip.tax_amount), type: "tax" }]
                    : []),
                ...deductions.map((a) => ({
                    label: a.title,
                    amount: num(a.amount),
                    type: a.adjustment_type,
                    note: a.remarks || null,
                    adjustment_id: a.id,
                })),
            ],
            totals: {
                gross_salary: num(payslip.gross_salary),
                overtime_amount: num(payslip.overtime_amount),
                adjustment_earnings: earningsTotal,
                adjustment_deductions: deductionsTotal,
                attendance_deduction: num(payslip.base_deduction_amount),
                tax_amount: num(payslip.tax_amount),
                total_earnings: parseFloat(
                    (num(payslip.gross_salary) + num(payslip.overtime_amount) + earningsTotal).toFixed(2)
                ),
                total_deductions: parseFloat(
                    (num(payslip.base_deduction_amount) + num(payslip.tax_amount) + deductionsTotal).toFixed(2)
                ),
                net_salary: num(payslip.net_salary),
            },
        },
    };
}

// ============================================================
// SERVICE
// ============================================================
const PayslipService = {

    // ----------------------------------------------------------
    // Generate payslip for a single payroll record
    // Only allowed when payroll_status = 'processed' or 'paid'
    // ----------------------------------------------------------
    async generatePayslip(payroll_id) {
        try {
            // 1. Fetch payroll with full details
            const payroll = await PayrollModel.findById(payroll_id);
            if (!payroll) {
                return { success: false, message: "Payroll record not found" };
            }

            const GENERATABLE_STATUSES = ["processed", "paid"];
            if (!GENERATABLE_STATUSES.includes(payroll.payroll_status)) {
                return {
                    success: false,
                    message: `Payslip can only be generated for processed or paid payrolls. Current status: '${payroll.payroll_status}'`,
                };
            }

            // 2. Check if payslip already exists
            const existing = await PayslipModel.findByPayrollId(payroll_id);
            if (existing) {
                return {
                    success: false,
                    message: "Payslip already exists for this payroll",
                    data: existing,
                };
            }

            // 3. Generate payslip number
            const payslipNumber = generatePayslipNumber(
                payroll.employee_code,
                payroll.period_start_date
            );

            // 4. Create payslip record
            const payslip = await PayslipModel.create({
                payroll_id,
                payslip_number: payslipNumber,
                pdf_url: null,  // PDF generated asynchronously or on-demand
            });

            return {
                success: true,
                message: "Payslip generated successfully",
                data: payslip,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ----------------------------------------------------------
    // Bulk-generate payslips for all payrolls in a period
    // Skips employees who already have a payslip
    // ----------------------------------------------------------
    async generatePayslipsForPeriod(company_id, payroll_period_id, { payroll_run_id = null } = {}) {
        try {

            const period = await PayrollPeriodModel.findById(payroll_period_id);
            if (!period) {
                return { success: false, message: "Payroll period not found" };
            }
            const payrolls = await PayrollModel.getAllByPeriod(company_id, payroll_period_id);
            if (!payrolls || payrolls.length === 0) {
                return {
                    success: false,
                    message: "No payroll records found for this period",
                };
            }

            const generated = [];
            const skipped = [];
            const errors = [];

            for (const payroll of payrolls) {
                try {
                    if (!["processed", "paid"].includes(payroll.payroll_status)) {
                        skipped.push({
                            payroll_id: payroll.id,
                            reason: `Status is '${payroll.payroll_status}' — must be processed or paid`,
                        });
                        continue;
                    }

                    const existing = await PayslipModel.findByPayrollId(payroll.id);
                    if (existing) {
                        skipped.push({
                            payroll_id: payroll.id,
                            reason: "Payslip already exists",
                        });
                        continue;
                    }

                    const payslipNumber = generatePayslipNumber(
                        payroll.employee_code,
                        period.start_date
                    );

                    const payslip = await PayslipModel.create({
                        payroll_id: payroll.id,
                        payslip_number: payslipNumber,
                        pdf_url: null,
                        payroll_run_id: payroll_run_id || payroll.payroll_run_id || null,
                    });

                    generated.push(payslip);
                } catch (err) {
                    errors.push({ payroll_id: payroll.id, error: err.message });
                }
            }

            return {
                success: true,
                message: `${generated.length} payslip(s) generated`,
                data: {
                    generated_count: generated.length,
                    skipped_count: skipped.length,
                    error_count: errors.length,
                    generated,
                    skipped,
                    errors,
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ----------------------------------------------------------
    // Email every payslip in a run.
    //
    // Resumable and idempotent: only 'pending' and 'failed' payslips are
    // attempted, and each result is written back per payslip. A crash or a
    // half-broken mail provider leaves the run in a state you can simply
    // retry, instead of forcing a choice between "send nothing" and
    // "send everyone a duplicate".
    //
    // @param {boolean} options.only_failed  retry the failures alone
    // ----------------------------------------------------------
    async emailPayslipsForRun(payroll_run_id, { only_failed = false } = {}) {
        try {
            const statuses = only_failed ? ["failed"] : ["pending", "failed"];
            const payslips = await PayslipModel.getAllByRun(payroll_run_id, { statuses });

            if (payslips.length === 0) {
                return {
                    success: true,
                    message: only_failed
                        ? "No failed payslips to retry"
                        : "All payslips in this run have already been emailed",
                    data: { sent_count: 0, failed_count: 0, skipped_count: 0, sent: [], failed: [], skipped: [] },
                };
            }

            const sent = [];
            const failed = [];
            const skipped = [];

            // One query for every employee's line items, rather than one per email.
            const adjustmentsByPayroll = await PayrollAdjustmentModel.getAllByPayrollIds(
                payslips.map((p) => p.payroll_id)
            );

            for (const payslip of payslips) {
                const employeeName = `${payslip.first_name || ""} ${payslip.last_name || ""}`.trim();

                if (!payslip.employee_email) {
                    await PayslipModel.markEmailSkipped(payslip.id, "Employee has no email address on file");
                    skipped.push({
                        payslip_id: payslip.id,
                        employee_code: payslip.employee_code,
                        reason: "No email address on file",
                    });
                    continue;
                }

                try {
                    await sendEmail({
                        to: payslip.employee_email,
                        subject: `Payslip — ${payslip.period_name}`,
                        html: payslipTemplate({
                            first_name: payslip.first_name,
                            company_name: payslip.company_name,
                            period_name: payslip.period_name,
                            period_start: payslip.period_start_date,
                            period_end: payslip.period_end_date,
                            payslip_number: payslip.payslip_number,
                            currency: payslip.currency,
                            gross_salary: payslip.gross_salary,
                            overtime_amount: payslip.overtime_amount,
                            overtime_hours: payslip.overtime_hours,
                            base_deduction_amount: payslip.base_deduction_amount,
                            tax_amount: payslip.tax_amount,
                            net_salary: payslip.net_salary,
                            // Itemised on the payslip so a deduction is never
                            // just an unexplained number.
                            adjustments: adjustmentsByPayroll[payslip.payroll_id] || [],
                            pdf_url: payslip.pdf_url,
                        }),
                    });

                    await PayslipModel.markEmailSent(payslip.id, payslip.employee_email);
                    sent.push({
                        payslip_id: payslip.id,
                        employee_code: payslip.employee_code,
                        employee_name: employeeName,
                        email: payslip.employee_email,
                    });
                } catch (err) {
                    // One bad address must not abort the batch.
                    await PayslipModel.markEmailFailed(payslip.id, err.message);
                    failed.push({
                        payslip_id: payslip.id,
                        employee_code: payslip.employee_code,
                        employee_name: employeeName,
                        email: payslip.employee_email,
                        error: err.message,
                    });
                }
            }

            return {
                success: true,
                message: `${sent.length} payslip(s) emailed`
                    + (failed.length ? `, ${failed.length} failed` : "")
                    + (skipped.length ? `, ${skipped.length} skipped` : ""),
                data: {
                    sent_count: sent.length,
                    failed_count: failed.length,
                    skipped_count: skipped.length,
                    sent, failed, skipped,
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ----------------------------------------------------------
    // Notify employees in-app and on their phones that a payslip
    // is available.
    //
    // Sent on both channels deliberately: `push` only reaches
    // employees with an active device token, so the `in_app` copy
    // is what guarantees an inbox row for everyone else.
    //
    // Tracked per payslip like the email step, so it is retryable
    // and never double-notifies.
    // ----------------------------------------------------------
    async notifyPayslipsForRun(payroll_run_id, { only_failed = false } = {}) {
        try {
            const statuses = only_failed ? ["failed"] : ["pending", "failed"];
            const payslips = await PayslipModel.getAllByRun(payroll_run_id, {
                statuses,
                column: "notification_status",
            });

            if (payslips.length === 0) {
                return {
                    success: true,
                    message: "Every employee in this run has already been notified",
                    data: { notified_count: 0, failed_count: 0, notified: [], failed: [] },
                };
            }

            const notified = [];
            const failed = [];

            for (const payslip of payslips) {
                const variables = {
                    employee_name: `${payslip.first_name || ""} ${payslip.last_name || ""}`.trim(),
                    employee_code: payslip.employee_code,
                    period_name: payslip.period_name,
                    payslip_number: payslip.payslip_number,
                    payslip_id: payslip.id,
                    currency: payslip.currency || "",
                    net_salary: Number(payslip.net_salary || 0).toFixed(2),
                };

                try {
                    const results = await Promise.all(["push", "in_app"].map((channel) =>
                        NotificationService.send({
                            company_id: payslip.company_id,
                            branch_id: payslip.branch_id || null,
                            notification_type: "payslip_published",
                            channel,
                            template_code: "payslip_published",
                            template_variables: variables,
                            entity_type: "payslip",
                            entity_id: payslip.id,
                            audience: { type: "specific_employee", employee_id: payslip.employee_id },
                        })
                    ));

                    const failures = results.filter((r) => !r.success);
                    if (failures.length === results.length) {
                        throw new Error(failures.map((f) => f.message).join("; "));
                    }

                    await PayslipModel.markNotified(payslip.id);
                    notified.push({
                        payslip_id: payslip.id,
                        employee_code: payslip.employee_code,
                        employee_name: variables.employee_name,
                    });
                } catch (err) {
                    // A failed notification must never block the next employee,
                    // and must never roll back a payment that already happened.
                    await PayslipModel.markNotificationFailed(payslip.id, err.message);
                    failed.push({
                        payslip_id: payslip.id,
                        employee_code: payslip.employee_code,
                        employee_name: variables.employee_name,
                        error: err.message,
                    });
                }
            }

            return {
                success: true,
                message: `${notified.length} employee(s) notified`
                    + (failed.length ? `, ${failed.length} failed` : ""),
                data: {
                    notified_count: notified.length,
                    failed_count: failed.length,
                    notified,
                    failed,
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ----------------------------------------------------------
    // Get a payslip by ID (with full context for rendering)
    // ----------------------------------------------------------
    async getPayslipById(id) {
        try {
            const payslip = await PayslipModel.findById(id);
            if (!payslip) {
                return { success: false, message: "Payslip not found" };
            }

            // Attach adjustments for rendering a complete payslip document
            const adjustments = await PayrollAdjustmentModel.getAllByPayroll(payslip.payroll_id);

            return { success: true, data: shapePayslip(payslip, adjustments) };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ----------------------------------------------------------
    // Get payslip by payroll ID
    // ----------------------------------------------------------
    async getPayslipByPayrollId(payroll_id) {
        try {
            const payslip = await PayslipModel.findByPayrollId(payroll_id);
            if (!payslip) {
                return { success: false, message: "Payslip not found for this payroll" };
            }
            const adjustments = await PayrollAdjustmentModel.getAllByPayroll(payroll_id);
            return { success: true, data: shapePayslip(payslip, adjustments) };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ----------------------------------------------------------
    // Get payslip by payslip number (e.g. from printed slip QR)
    // ----------------------------------------------------------
    async getPayslipByNumber(payslip_number) {
        try {
            const payslip = await PayslipModel.findByPayslipNumber(payslip_number);
            if (!payslip) {
                return { success: false, message: "Payslip not found" };
            }
            const adjustments = await PayrollAdjustmentModel.getAllByPayroll(payslip.payroll_id);
            return { success: true, data: shapePayslip(payslip, adjustments) };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ----------------------------------------------------------
    // Get all payslips for an employee (payslip history)
    // ----------------------------------------------------------
    async getPayslipsByEmployee(employee_id) {
        try {
            const result = await PayslipModel.getAllByEmployee(employee_id);
            return { success: true, data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ----------------------------------------------------------
    // Get all payslips for a payroll period
    // ----------------------------------------------------------
    async getPayslipsByPeriod(payroll_period_id) {
        try {
            const result = await PayslipModel.getAllByPeriod(payroll_period_id);
            return { success: true, data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ----------------------------------------------------------
    // Attach or update the PDF URL once the PDF is generated
    // ----------------------------------------------------------
    async updatePdfUrl(id, pdf_url) {
        try {
            if (!pdf_url || !pdf_url.trim()) {
                return { success: false, message: "pdf_url is required" };
            }

            const payslip = await PayslipModel.findById(id);
            if (!payslip) {
                return { success: false, message: "Payslip not found" };
            }

            const result = await PayslipModel.updatePdfUrl(id, pdf_url.trim());

            return {
                success: true,
                message: "PDF URL updated successfully",
                data: result,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ----------------------------------------------------------
    // Delete a payslip (e.g. to regenerate after corrections)
    // Only allowed when payroll is in draft or processed state
    // ----------------------------------------------------------
    async deletePayslip(id) {
        try {
            const payslip = await PayslipModel.findById(id);
            if (!payslip) {
                return { success: false, message: "Payslip not found" };
            }

            // Guard: do not allow deletion if payroll is already paid
            const payroll = await PayrollModel.findById(payslip.payroll_id);
            if (payroll && payroll.payroll_status === "paid") {
                return {
                    success: false,
                    message: "Cannot delete a payslip linked to a paid payroll",
                };
            }

            const result = await PayslipModel.delete(id);
            return { success: true, message: "Payslip deleted successfully", data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },
};

module.exports = PayslipService;