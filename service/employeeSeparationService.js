const EmployeeSeparationModel = require("../models/employeeSeparationModel");
const LeaveSalaryModel = require("../models/leaveSalaryModel");
const LeaveSalaryPayoutModel = require("../models/leaveSalaryPayoutModel");
const LeaveSalaryService = require("./leaveSalaryService");
const EmployeeGratuityService = require("./employeeGratuityService");
const EntitlementService = require("./entitlementService");
const EmployeeModel = require("../models/employeeModel");
const { Feature } = require("../enums/features");
const {
    SeparationType,
    SeparationStatus,
    TerminationType,
    TERMINATION_TYPE_META,
    SEPARATION_EMPLOYEE_STATUS,
    EncashmentType,
} = require("../enums/leaveSalaryRules");
const {
    calculateNoticeShortfall,
    calendarDaysInclusive,
} = require("../utils/leaveSalaryCalculator");
const { round2, toISODate, toUTCDate } = require("../utils/gratuityCalculator");

/**
 * Resignation, termination and final settlement.
 *
 * The two entry points differ only in who may start them and which fields they
 * carry. Everything after the decision — notice, settlement, completion — is one
 * path, because an employee who has left has left, and duplicating that logic is
 * how someone ends up deactivated with no settlement, or settled but still on
 * payroll.
 *
 * Three rules worth stating outright:
 *
 *   * NOTHING DEACTIVATES THE EMPLOYEE UNTIL COMPLETION. Someone serving notice
 *     still checks in, still appears on payroll, still takes leave. Standing
 *     them down at submission would strand a month of attendance.
 *
 *   * THE SETTLEMENT IS A SNAPSHOT. The leave-salary balance and the gratuity
 *     accrual are both derived on read everywhere else in this codebase; here
 *     they are frozen, because what was agreed and paid must not move when a
 *     salary is corrected next month.
 *
 *   * GRATUITY FORFEITURE IS ALWAYS EXPLICIT. UAE Art. 44 allows it on dismissal
 *     for cause; the termination type only *suggests* it in the UI. Nothing here
 *     forfeits an entitlement as a side effect of a dropdown.
 */

const today = () => new Date().toISOString().slice(0, 10);

const isNum = (v) => v !== null && v !== undefined && v !== "" && !isNaN(Number(v));

/**
 * Any date-ish value → "YYYY-MM-DD", or null.
 *
 * node-pg hands back DATE columns as JS Date objects, and `String(date)` gives
 * "Fri Aug 14 2026 04:00:00 GMT+0400" — slicing ten characters off that yields
 * "Fri Aug 14", which Postgres then rejects on the way back in. So everything
 * goes through toUTCDate, which reads a Date's local parts (node-pg builds DATE
 * at local midnight) and parses ISO strings, and returns null for anything it
 * cannot make sense of rather than a plausible-looking wrong date.
 */
const asDate = (v) => (v ? toISODate(toUTCDate(v)) : null);

const EmployeeSeparationService = {
    // ─────────────────────────────────────────────────────────────────────────
    // SUBMISSION
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Resignation. Normally submitted by the employee for themselves; an admin
     * may file one on their behalf (a verbal or paper resignation), which is why
     * employee_id is accepted rather than always taken from the token.
     */
    async submitResignation(company_id, payload = {}, { user_id, employee_id = null } = {}) {
        try {
            const {
                reason, requested_last_working_date = null,
                notice_period_days = 30, notes = null,
            } = payload;

            if (!reason || !String(reason).trim()) {
                return { success: false, message: "A resignation reason is required" };
            }

            const employee = await this._resolveEmployee(company_id, employee_id ?? payload.employee_id, user_id);
            if (!employee.success) return employee;

            const open = await EmployeeSeparationModel.findOpenByEmployee(employee.data.id);
            if (open) {
                return {
                    success: false,
                    message: `This employee already has an open ${open.separation_type} (status: ${open.status}).`,
                    data: { separation_id: open.id },
                };
            }

            if (!isNum(notice_period_days) || Number(notice_period_days) < 0) {
                return { success: false, message: "notice_period_days must be a number >= 0" };
            }

            // Default the requested date to the end of the notice period, so a
            // resignation always carries a date the rota can be planned around.
            const requested = requested_last_working_date
                ? asDate(requested_last_working_date)
                : toISODate(
                    new Date(
                        toUTCDate(today()).getTime() + Number(notice_period_days) * 86400000
                    )
                );

            const created = await EmployeeSeparationModel.create({
                company_id,
                employee_id: employee.data.id,
                branch_id: employee.data.branch_id,
                department_id: employee.data.department_id,
                separation_type: SeparationType.RESIGNATION,
                reason,
                submitted_by: user_id,
                requested_last_working_date: requested,
                notice_period_days: Number(notice_period_days),
                notice_start_date: today(),
                clearance_checklist: payload.clearance_checklist ?? [],
            });

            return {
                success: true,
                message: "Resignation submitted",
                data: { ...created, notes },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    /** Termination. Admin only — the route enforces the role. */
    async initiateTermination(company_id, payload = {}, { user_id } = {}) {
        try {
            const {
                employee_id, reason, termination_type,
                requested_last_working_date = null,
                notice_period_days = 30,
                is_gratuity_forfeited = false,
                forfeiture_reason = null,
            } = payload;

            if (!employee_id) return { success: false, message: "employee_id is required" };
            if (!reason || !String(reason).trim()) {
                return { success: false, message: "A termination reason is required" };
            }
            if (!Object.values(TerminationType).includes(termination_type)) {
                return {
                    success: false,
                    message: `termination_type must be one of: ${Object.values(TerminationType).join(", ")}`,
                };
            }
            // Forfeiting end-of-service pay is the single most consequential
            // thing this module can do, so it never happens without a reason on
            // the record that someone can be held to.
            if (is_gratuity_forfeited && !forfeiture_reason) {
                return {
                    success: false,
                    message:
                        "forfeiture_reason is required when gratuity is forfeited (UAE Art. 44 requires stated grounds)",
                };
            }

            const employee = await this._resolveEmployee(company_id, employee_id, null);
            if (!employee.success) return employee;

            const open = await EmployeeSeparationModel.findOpenByEmployee(employee_id);
            if (open) {
                return {
                    success: false,
                    message: `This employee already has an open ${open.separation_type} (status: ${open.status}).`,
                    data: { separation_id: open.id },
                };
            }

            const meta = TERMINATION_TYPE_META[termination_type];
            const noticeDays = meta.requires_notice ? Number(notice_period_days) : 0;

            const created = await EmployeeSeparationModel.create({
                company_id,
                employee_id,
                branch_id: employee.data.branch_id,
                department_id: employee.data.department_id,
                separation_type: SeparationType.TERMINATION,
                reason,
                submitted_by: user_id,
                requested_last_working_date: requested_last_working_date
                    ? asDate(requested_last_working_date)
                    : toISODate(new Date(toUTCDate(today()).getTime() + noticeDays * 86400000)),
                notice_period_days: noticeDays,
                notice_start_date: today(),
                termination_type,
                is_gratuity_forfeited,
                forfeiture_reason,
                clearance_checklist: payload.clearance_checklist ?? [],
            });

            return { success: true, message: "Termination initiated", data: created };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ─────────────────────────────────────────────────────────────────────────
    // READS
    // ─────────────────────────────────────────────────────────────────────────

    async listByCompany(company_id, filters = {}) {
        try {
            const [cases, counts, overdue] = await Promise.all([
                EmployeeSeparationModel.listByCompany(company_id, filters),
                EmployeeSeparationModel.countsByStatus(company_id),
                EmployeeSeparationModel.listOverdueForCompletion(company_id),
            ]);

            return {
                success: true,
                data: {
                    count: cases.length,
                    counts_by_status: counts,
                    // Approved cases whose last day has passed and which nobody
                    // has closed. Left alone, these are ex-employees who can
                    // still log in.
                    overdue_completion: overdue.map((c) => ({
                        separation_id: c.id,
                        employee_id: c.employee_id,
                        employee_name: `${c.first_name} ${c.last_name}`,
                        last_working_date: asDate(c.last_working_date),
                    })),
                    separations: cases,
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async getById(company_id, id) {
        try {
            const separation = await EmployeeSeparationModel.findById(id);
            if (!separation) return { success: false, message: "Separation not found" };
            if (String(separation.company_id) !== String(company_id)) {
                return { success: false, message: "Separation does not belong to this company" };
            }

            const settlement = await EmployeeSeparationModel.findSettlementBySeparation(id);

            return {
                success: true,
                data: {
                    separation,
                    settlement: settlement ?? null,
                    termination_meta: separation.termination_type
                        ? TERMINATION_TYPE_META[separation.termination_type]
                        : null,
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    /** The employee's own cases — what the mobile app shows. */
    async getForUser(user_id, company_id) {
        try {
            const employee = await EmployeeModel.findByUserAndCompany(user_id, company_id);
            if (!employee) {
                return { success: false, message: "No employee profile found for this user in this company" };
            }

            const cases = await EmployeeSeparationModel.listByEmployee(employee.id);

            return {
                success: true,
                data: {
                    employee_id: employee.id,
                    open_case: cases.find((c) =>
                        [SeparationStatus.PENDING, SeparationStatus.APPROVED].includes(c.status)) ?? null,
                    history: cases,
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    /** Reference data for the forms: termination grounds and what each implies. */
    getTerminationTypes() {
        return {
            success: true,
            data: {
                types: Object.values(TerminationType).map((code) => ({
                    code,
                    ...TERMINATION_TYPE_META[code],
                })),
                note:
                    "forfeits_gratuity_by_default is a suggestion for the form only. " +
                    "Forfeiture must be set explicitly with a stated reason.",
            },
        };
    },

    // ─────────────────────────────────────────────────────────────────────────
    // WORKFLOW
    // ─────────────────────────────────────────────────────────────────────────

    async update(company_id, id, payload = {}) {
        try {
            const found = await this._load(company_id, id);
            if (!found.success) return found;

            const updated = await EmployeeSeparationModel.update(id, payload);
            if (!updated) {
                return {
                    success: false,
                    message: `Only a pending case can be edited — this one is ${found.data.status}.`,
                };
            }

            return { success: true, message: "Separation updated", data: updated };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    /**
     * Accept the resignation / confirm the termination and fix the last working
     * date. The notice shortfall is computed here, once, and stored — the
     * settlement must not recompute it later against dates that have moved.
     */
    async approve(company_id, id, payload = {}, { user_id } = {}) {
        try {
            const found = await this._load(company_id, id);
            if (!found.success) return found;

            const separation = found.data;

            const last_working_date = asDate(
                payload.last_working_date ?? separation.requested_last_working_date
            );
            if (!last_working_date) {
                return {
                    success: false,
                    message: "last_working_date is required — the settlement and final payroll depend on it",
                };
            }

            const notice_start_date = asDate(payload.notice_start_date ?? separation.notice_start_date) || today();
            const is_notice_waived = payload.is_notice_waived === true;

            // Waiving notice writes off the shortfall; not waiving it prices it.
            const shortfall = is_notice_waived
                ? { shortfall_days: 0 }
                : calculateNoticeShortfall({
                    notice_start_date,
                    notice_period_days: separation.notice_period_days,
                    last_working_date,
                    basis_amount: 0,      // priced at settlement time, against the
                    days_in_month: 30,    // basis in force then
                });

            const updated = await EmployeeSeparationModel.approve(id, {
                decided_by: user_id,
                last_working_date,
                notice_start_date,
                notice_shortfall_days: shortfall.shortfall_days,
                is_notice_waived,
                decision_notes: payload.decision_notes ?? null,
            });

            if (!updated) {
                return {
                    success: false,
                    message: `Only a pending case can be approved — this one is ${separation.status}.`,
                };
            }

            return {
                success: true,
                message:
                    separation.separation_type === SeparationType.RESIGNATION
                        ? "Resignation accepted"
                        : "Termination confirmed",
                data: {
                    ...updated,
                    notice: {
                        notice_start_date,
                        required_days: separation.notice_period_days,
                        shortfall_days: shortfall.shortfall_days,
                        is_waived: is_notice_waived,
                    },
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async reject(company_id, id, rejection_reason, { user_id } = {}) {
        try {
            if (!rejection_reason) {
                return { success: false, message: "A rejection reason is required" };
            }

            const found = await this._load(company_id, id);
            if (!found.success) return found;

            const updated = await EmployeeSeparationModel.reject(id, {
                decided_by: user_id,
                rejection_reason,
            });
            if (!updated) {
                return {
                    success: false,
                    message: `Only a pending case can be rejected — this one is ${found.data.status}.`,
                };
            }

            return { success: true, message: "Separation rejected", data: updated };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    /**
     * The employee withdrawing their own resignation, before a decision.
     * Identity-checked here rather than by role: the person withdrawing must be
     * the person who resigned.
     */
    async withdraw(company_id, id, { user_id, withdrawal_reason = null } = {}) {
        try {
            const found = await this._load(company_id, id);
            if (!found.success) return found;

            const separation = found.data;

            if (separation.separation_type !== SeparationType.RESIGNATION) {
                return { success: false, message: "Only a resignation can be withdrawn" };
            }

            const employee = await EmployeeModel.findByUserAndCompany(user_id, company_id);
            if (!employee || String(employee.id) !== String(separation.employee_id)) {
                return { success: false, message: "You can only withdraw your own resignation" };
            }

            const updated = await EmployeeSeparationModel.withdraw(id, withdrawal_reason);
            if (!updated) {
                return {
                    success: false,
                    message:
                        separation.status === SeparationStatus.APPROVED
                            ? "This resignation has already been accepted — ask an admin to cancel it instead."
                            : `This resignation is ${separation.status} and can no longer be withdrawn.`,
                };
            }

            return { success: true, message: "Resignation withdrawn", data: updated };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    /** Admin revoking an accepted case. The employee stays employed. */
    async cancel(company_id, id, cancellation_reason) {
        try {
            if (!cancellation_reason) {
                return { success: false, message: "A cancellation reason is required" };
            }

            const found = await this._load(company_id, id);
            if (!found.success) return found;

            const settlement = await EmployeeSeparationModel.findSettlementBySeparation(id);
            if (settlement && settlement.status === "paid") {
                return {
                    success: false,
                    message: "The final settlement has already been paid — this case cannot be cancelled.",
                };
            }

            const updated = await EmployeeSeparationModel.cancel(id, cancellation_reason);
            if (!updated) {
                return {
                    success: false,
                    message: `Only an approved case can be cancelled — this one is ${found.data.status}.`,
                };
            }

            // The encashment raised for a settlement that is no longer happening
            // has to go back into the bucket, or the employee stays short of the
            // days they never got paid for.
            const encashment = await LeaveSalaryPayoutModel.findEncashmentBySeparation(id);
            if (encashment && encashment.status !== "paid") {
                await LeaveSalaryPayoutModel.cancelEncashment(
                    encashment.id,
                    `Separation cancelled: ${cancellation_reason}`
                );
            }
            if (settlement) {
                await EmployeeSeparationModel.cancelSettlement(
                    settlement.id,
                    `Separation cancelled: ${cancellation_reason}`
                );
            }

            return { success: true, message: "Separation cancelled", data: updated };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    /**
     * Close the case: the employee's last day has passed, they are stood down.
     *
     * Refuses before the last working date unless explicitly forced, because
     * completing early strips access from somebody who is still turning up.
     */
    async complete(company_id, id, payload = {}, { user_id } = {}) {
        try {
            const found = await this._load(company_id, id);
            if (!found.success) return found;

            const separation = found.data;

            if (separation.status !== SeparationStatus.APPROVED) {
                return {
                    success: false,
                    message: `Only an approved case can be completed — this one is ${separation.status}.`,
                };
            }

            const lwd = asDate(separation.last_working_date);
            if (lwd > today() && payload.force !== true) {
                return {
                    success: false,
                    message: `The last working date (${lwd}) has not passed yet. Pass force: true to close the case early.`,
                };
            }

            const settlement = await EmployeeSeparationModel.findSettlementBySeparation(id);
            if (!settlement && payload.allow_without_settlement !== true) {
                return {
                    success: false,
                    message:
                        "No final settlement has been recorded. Save one first, or pass " +
                        "allow_without_settlement: true if it is being handled outside the system.",
                };
            }

            const updated = await EmployeeSeparationModel.complete(id, {
                completed_by: user_id,
                employee_status: SEPARATION_EMPLOYEE_STATUS[separation.separation_type],
                exit_interview_notes: payload.exit_interview_notes ?? null,
                is_rehire_eligible: payload.is_rehire_eligible ?? null,
                clearance_checklist: payload.clearance_checklist ?? null,
            });

            if (!updated) {
                return { success: false, message: "This case is no longer awaiting completion" };
            }

            return {
                success: true,
                message: `Separation completed — employee marked ${SEPARATION_EMPLOYEE_STATUS[separation.separation_type]}`,
                data: updated,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ─────────────────────────────────────────────────────────────────────────
    // FINAL SETTLEMENT
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Everything owed, computed live. Nothing is written.
     *
     * The three figures the system can derive — leave encashment, gratuity and
     * the notice shortfall — come out fully broken down. The two it cannot —
     * unpaid salary for the final part-month, and any other adjustment — are
     * returned as zero with a suggestion, because payroll owns the first and
     * only a human knows the second.
     */
    async previewSettlement(company_id, id) {
        try {
            const found = await this._load(company_id, id);
            if (!found.success) return found;

            const separation = found.data;
            const lwd = asDate(separation.last_working_date ?? separation.requested_last_working_date);

            if (!lwd) {
                return {
                    success: false,
                    message: "This case has no last working date yet — approve it first",
                };
            }

            // ── Leave encashment ────────────────────────────────────────────
            const bucket = await LeaveSalaryService.getForEmployee(separation.employee_id, {
                as_of_date: lwd,
                include_ledger: false,
            });
            if (!bucket.success) return bucket;

            const balance = bucket.data.balance;
            const encashment_days = Math.max(0, balance.balance_days);
            const encashment_amount = round2(encashment_days * balance.daily_rate);

            // ── Gratuity ────────────────────────────────────────────────────
            const gratuity = await this._resolveGratuity(company_id, separation, lwd);

            // ── Notice shortfall ────────────────────────────────────────────
            const notice = calculateNoticeShortfall({
                notice_start_date: asDate(separation.notice_start_date),
                notice_period_days: separation.notice_period_days,
                last_working_date: lwd,
                basis_amount: balance.basis_amount,
                days_in_month: balance.days_in_month,
            });
            const shortfall_days = separation.is_notice_waived
                ? 0
                : Number(separation.notice_shortfall_days ?? notice.shortfall_days);
            const shortfall_amount = round2(shortfall_days * balance.daily_rate);

            // ── Advances that outran the employment ─────────────────────────
            // Leave salary paid for holiday that now falls after the last
            // working day was paid for leave that will never be taken.
            const advances = await LeaveSalaryPayoutModel.listAdvances({
                company_id,
                employee_id: separation.employee_id,
                status: "paid",
            });
            const recoverable = advances.filter((a) => asDate(a.leave_from_date) > lwd);
            const advance_recovery_suggested = round2(
                recoverable.reduce((acc, a) => acc + Number(a.amount), 0)
            );

            const total_earnings = round2(encashment_amount + gratuity.amount);
            const total_deductions = round2(shortfall_amount + advance_recovery_suggested);

            return {
                success: true,
                data: {
                    separation_id: separation.id,
                    employee_id: separation.employee_id,
                    employee_name: `${separation.first_name} ${separation.last_name}`,
                    separation_type: separation.separation_type,
                    last_working_date: lwd,
                    service: {
                        joining_date: asDate(separation.joining_date),
                        total_days: calendarDaysInclusive(asDate(separation.joining_date), lwd),
                    },

                    calculation_base: balance.calculation_base,
                    basis_amount: balance.basis_amount,
                    days_in_month: balance.days_in_month,
                    daily_rate: balance.daily_rate,
                    currency: balance.currency,

                    earnings: {
                        leave_encashment_days: encashment_days,
                        leave_encashment_amount: encashment_amount,
                        gratuity_amount: gratuity.amount,
                        gratuity_note: gratuity.note,
                        // Payroll is the authority on what is still owed for the
                        // final part-month, so this is entered, not derived.
                        pending_salary_amount: 0,
                        other_earnings_amount: 0,
                    },
                    deductions: {
                        notice_shortfall_days: shortfall_days,
                        notice_shortfall_amount: shortfall_amount,
                        advance_recovery_amount: advance_recovery_suggested,
                        other_deductions_amount: 0,
                    },

                    total_earnings,
                    total_deductions,
                    net_settlement_amount: round2(total_earnings - total_deductions),

                    breakdown: {
                        leave_salary_balance: balance,
                        gratuity: gratuity.detail,
                        notice,
                        recoverable_advances: recoverable.map((a) => ({
                            advance_id: a.id,
                            leave_from_date: asDate(a.leave_from_date),
                            leave_to_date: asDate(a.leave_to_date),
                            amount: Number(a.amount),
                        })),
                    },

                    inputs_required: [
                        "pending_salary_amount — unpaid salary up to the last working day (from payroll)",
                        "other_earnings_amount / other_deductions_amount — anything agreed outside the system",
                    ],
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    /**
     * Freeze the settlement, and raise the encashment that pays the balance out.
     *
     * The encashment is what removes those days from the bucket — without it the
     * employee would leave with a balance still showing against a company they
     * no longer work for.
     */
    async saveSettlement(company_id, id, payload = {}, { user_id } = {}) {
        try {
            const preview = await this.previewSettlement(company_id, id);
            if (!preview.success) return preview;

            const p = preview.data;

            const existing = await EmployeeSeparationModel.findSettlementBySeparation(id);
            if (existing && existing.status !== "draft") {
                return {
                    success: false,
                    message: `The settlement is already ${existing.status} and can no longer be edited.`,
                    data: existing,
                };
            }

            // Admin-supplied figures override the derived ones; anything left
            // out keeps what the preview computed.
            const num = (v, fallback) => (isNum(v) ? round2(Number(v)) : fallback);

            const leave_encashment_days = num(payload.leave_encashment_days, p.earnings.leave_encashment_days);
            if (leave_encashment_days > p.earnings.leave_encashment_days) {
                return {
                    success: false,
                    message: `Only ${p.earnings.leave_encashment_days} day(s) are available to encash.`,
                };
            }

            const leave_encashment_amount = round2(leave_encashment_days * p.daily_rate);
            const gratuity_amount = num(payload.gratuity_amount, p.earnings.gratuity_amount);
            const pending_salary_amount = num(payload.pending_salary_amount, 0);
            const other_earnings_amount = num(payload.other_earnings_amount, 0);

            const notice_shortfall_days = num(payload.notice_shortfall_days, p.deductions.notice_shortfall_days);
            const notice_shortfall_amount = round2(notice_shortfall_days * p.daily_rate);
            const advance_recovery_amount = num(payload.advance_recovery_amount, p.deductions.advance_recovery_amount);
            const other_deductions_amount = num(payload.other_deductions_amount, 0);

            const total_earnings = round2(
                leave_encashment_amount + gratuity_amount + pending_salary_amount + other_earnings_amount
            );
            const total_deductions = round2(
                notice_shortfall_amount + advance_recovery_amount + other_deductions_amount
            );

            const settlement = await EmployeeSeparationModel.upsertSettlement({
                company_id,
                employee_id: p.employee_id,
                separation_id: id,
                last_working_date: p.last_working_date,
                calculation_base: p.calculation_base,
                basis_amount: p.basis_amount,
                days_in_month: p.days_in_month,
                daily_rate: p.daily_rate,
                leave_encashment_days,
                leave_encashment_amount,
                gratuity_amount,
                gratuity_note: payload.gratuity_note ?? p.earnings.gratuity_note,
                pending_salary_amount,
                other_earnings_amount,
                other_earnings_note: payload.other_earnings_note ?? null,
                notice_shortfall_days,
                notice_shortfall_amount,
                advance_recovery_amount,
                other_deductions_amount,
                other_deductions_note: payload.other_deductions_note ?? null,
                total_earnings,
                total_deductions,
                net_settlement_amount: round2(total_earnings - total_deductions),
                currency: p.currency,
                calculation_snapshot: p.breakdown,
                notes: payload.notes ?? null,
                created_by: user_id,
            });

            if (!settlement) {
                return {
                    success: false,
                    message: "The settlement has already been approved and can no longer be edited.",
                };
            }

            // One encashment per case, replaced rather than stacked while the
            // settlement is still being worked on.
            let encashment = await LeaveSalaryPayoutModel.findEncashmentBySeparation(id);
            if (encashment && encashment.status === "pending") {
                await LeaveSalaryPayoutModel.cancelEncashment(encashment.id, "Settlement recalculated");
                encashment = null;
            }

            if (!encashment && leave_encashment_days > 0) {
                const created = await LeaveSalaryService.createEncashment(
                    company_id,
                    {
                        employee_id: p.employee_id,
                        days: leave_encashment_days,
                        effective_date: p.last_working_date,
                        encashment_type: EncashmentType.FINAL_SETTLEMENT,
                        separation_id: id,
                        notes: `Final settlement for ${p.separation_type}`,
                    },
                    user_id
                );
                encashment = created.success ? created.data.encashment : null;
            }

            return {
                success: true,
                message: "Final settlement saved",
                data: { settlement, encashment },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async approveSettlement(company_id, id, { user_id } = {}) {
        try {
            const settlement = await EmployeeSeparationModel.findSettlementBySeparation(id);
            if (!settlement) return { success: false, message: "No settlement recorded for this case" };
            if (String(settlement.company_id) !== String(company_id)) {
                return { success: false, message: "Settlement does not belong to this company" };
            }

            const approved = await EmployeeSeparationModel.approveSettlement(settlement.id, user_id);
            if (!approved) {
                return {
                    success: false,
                    message: `Only a draft settlement can be approved — this one is ${settlement.status}.`,
                };
            }

            const encashment = await LeaveSalaryPayoutModel.findEncashmentBySeparation(id);
            if (encashment && encashment.status === "pending") {
                await LeaveSalaryPayoutModel.approveEncashment(encashment.id, user_id);
            }

            return { success: true, message: "Final settlement approved", data: approved };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async markSettlementPaid(company_id, id, { payment_reference = null } = {}) {
        try {
            const settlement = await EmployeeSeparationModel.findSettlementBySeparation(id);
            if (!settlement) return { success: false, message: "No settlement recorded for this case" };
            if (String(settlement.company_id) !== String(company_id)) {
                return { success: false, message: "Settlement does not belong to this company" };
            }

            const paid = await EmployeeSeparationModel.markSettlementPaid(settlement.id, { payment_reference });
            if (!paid) {
                return {
                    success: false,
                    message: `Only an approved settlement can be marked paid — this one is ${settlement.status}.`,
                };
            }

            const encashment = await LeaveSalaryPayoutModel.findEncashmentBySeparation(id);
            if (encashment && encashment.status === "approved") {
                await LeaveSalaryPayoutModel.markEncashmentPaid(encashment.id, { payment_reference });
            }

            return { success: true, message: "Final settlement marked as paid", data: paid };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async listSettlements(company_id, filters = {}) {
        try {
            const settlements = await EmployeeSeparationModel.listSettlements(company_id, filters);
            return {
                success: true,
                data: {
                    count: settlements.length,
                    total_net: round2(settlements.reduce((a, s) => a + Number(s.net_settlement_amount), 0)),
                    settlements,
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ─────────────────────────────────────────────────────────────────────────
    // Internals
    // ─────────────────────────────────────────────────────────────────────────

    async _load(company_id, id) {
        const separation = await EmployeeSeparationModel.findById(id);
        if (!separation) return { success: false, message: "Separation not found" };
        if (String(separation.company_id) !== String(company_id)) {
            return { success: false, message: "Separation does not belong to this company" };
        }
        return { success: true, data: separation };
    },

    async _resolveEmployee(company_id, employee_id, user_id) {
        const employee = employee_id
            ? await EmployeeModel.findById(employee_id)
            : await EmployeeModel.findByUserAndCompany(user_id, company_id);

        if (!employee) {
            return {
                success: false,
                message: employee_id
                    ? "Employee not found"
                    : "No employee profile found for this user in this company",
            };
        }
        if (String(employee.company_id) !== String(company_id)) {
            return { success: false, message: "Employee does not belong to this company" };
        }
        if (employee.status !== "active") {
            return {
                success: false,
                message: `This employee is already ${employee.status}`,
            };
        }

        return { success: true, data: employee };
    },

    /**
     * Gratuity for the settlement, with two reasons it can legitimately be zero
     * — both of which are recorded rather than left as an unexplained 0.00:
     *
     *   * forfeited under Art. 44 (a decision taken on the case)
     *   * the company's plan does not include gratuity (a Gold feature)
     */
    async _resolveGratuity(company_id, separation, last_working_date) {
        if (separation.is_gratuity_forfeited) {
            return {
                amount: 0,
                note: `Gratuity forfeited: ${separation.forfeiture_reason}`,
                detail: null,
            };
        }

        const entitled = await EntitlementService.hasFeature(company_id, Feature.GRATUITY_CALCULATE);
        if (!entitled) {
            return {
                amount: 0,
                note:
                    "Gratuity is not included in your current plan — calculate it separately " +
                    "or upgrade to include it in the settlement.",
                detail: null,
            };
        }

        const result = await EmployeeGratuityService.getForEmployee(separation.employee_id, {
            as_of_date: last_working_date,
        });

        if (!result.success) {
            return { amount: 0, note: result.message, detail: null };
        }

        const calc = result.data.calculation;
        return {
            amount: round2(calc.amount ?? 0),
            note: calc.eligible ? null : calc.reason,
            detail: calc,
        };
    },
};

module.exports = EmployeeSeparationService;
