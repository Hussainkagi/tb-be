// service/payrollRunService.js
//
// The payroll flow, end to end, as ONE object.
//
// Before this, the UI drove five independent endpoints and nothing recorded
// where a user had got to. Leaving the page mid-way lost the thread, and
// nothing stopped the same person from generating a payroll and approving it.
//
// A payroll_run now owns the whole journey:
//
//   setup → generate → adjust → review → approval → payment → payslips → done
//
// Every transition is validated against the run's current status, recorded in
// payroll_run_events, and gated by maker-checker where it matters.

const db = require("../config/database");
const PayrollRunModel = require("../models/payrollRunModel");
const PayrollModel = require("../models/payrollModel");
const PayrollPeriodModel = require("../models/payrollPeriodModel");
const PayrollSettingsModel = require("../models/payrollSettingsModel");
const PayrollAdjustmentModel = require("../models/payrollAdjustmentModel");
const PayslipModel = require("../models/payslipModel");

const PayrollService = require("./payrollService");
const PayrollPeriodService = require("./payrollPeriodService");
const PayslipService = require("./payslipService");
const { toDateString } = require("./payrollEngineService");

const {
    STEP,
    STEP_ORDER,
    STEP_LABEL,
    RUN_STATUS,
    RUN_STATUS_TRANSITIONS,
    EDITABLE_STATUSES,
    RUN_ACTION,
    ACTOR_ROLE,
    stepIndex,
    isStepAtLeast,
} = require("../enums/payrollFlow");

// ============================================================
// HELPERS
// ============================================================

function fail(message, extra = {}) {
    return { success: false, message, ...extra };
}

function generateRunNumber(startDate) {
    // start_date arrives as a Date when it comes from PayrollPeriodModel, and
    // String(new Date(...)) is "Thu Oct 01 2026 …" — slicing that produced run
    // numbers like "PR-Thu Oct-O0Y2". Normalise to YYYY-MM-DD first.
    const yyyymm = toDateString(startDate).slice(0, 7).replace("-", "");
    const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `PR-${yyyymm}-${rand}`;
}

/**
 * Guard for every write path: the run must exist, belong to this company,
 * and be in a status that still permits changes.
 */
async function loadEditableRun(run_id, company_id) {
    const run = await PayrollRunModel.findById(run_id);
    if (!run) return { error: fail("Payroll run not found") };
    if (run.company_id !== company_id) return { error: fail("Payroll run does not belong to this company") };
    if (!EDITABLE_STATUSES.includes(run.status)) {
        return {
            error: fail(
                `This payroll run is '${run.status}' and can no longer be edited.`
                + (run.status === RUN_STATUS.PENDING_APPROVAL
                    ? " Ask the approver to reject it first if changes are needed."
                    : "")
            ),
        };
    }
    return { run };
}

function assertStatusTransition(run, to) {
    const allowed = RUN_STATUS_TRANSITIONS[run.status] || [];
    if (!allowed.includes(to)) {
        return fail(
            `Cannot move this run from '${run.status}' to '${to}'.`
            + ` Allowed: ${allowed.length ? allowed.join(", ") : "none"}`
        );
    }
    return null;
}

/**
 * Advance the recorded step only when moving forward. A user revisiting the
 * adjustments screen after reaching review must not drag progress backwards.
 */
function furthestStep(current, candidate) {
    return stepIndex(candidate) > stepIndex(current) ? candidate : current;
}

/**
 * Move the run on to the final step once BOTH delivery channels have settled —
 * every payslip either sent or deliberately skipped, none pending or failed.
 *
 * Neither the email nor the notify handler can decide this alone: emailing
 * everyone while notifications are still failing is not "done". Keeping the
 * rule in one query also means the step and `progress.can_complete` are
 * derived from the same facts and cannot disagree.
 */
async function maybeAdvanceToDone(run_id) {
    const { rows } = await db.query(
        `SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE ps.email_status IN ('pending','failed'))::int        AS email_outstanding,
            COUNT(*) FILTER (WHERE ps.notification_status IN ('pending','failed'))::int AS notify_outstanding
         FROM payslips ps
         JOIN payrolls p ON ps.payroll_id = p.id
         WHERE p.payroll_run_id = $1`,
        [run_id]
    );

    const s = rows[0];
    const settled = s.total > 0 && s.email_outstanding === 0 && s.notify_outstanding === 0;
    if (settled) await PayrollRunModel.update(run_id, { current_step: STEP.DONE });
    return settled;
}

// ============================================================
// PROGRESS — what the wizard renders, and what "resume" means
// ============================================================
async function buildProgress(run) {
    const [statusCounts, payslipStats] = await Promise.all([
        PayrollModel.countByStatusForRun(run.id),
        db.query(
            `SELECT
                COUNT(*)::int                                                  AS total,
                COUNT(*) FILTER (WHERE ps.email_status = 'sent')::int          AS emailed,
                COUNT(*) FILTER (WHERE ps.email_status = 'failed')::int        AS email_failed,
                COUNT(*) FILTER (WHERE ps.email_status = 'pending')::int       AS email_pending,
                COUNT(*) FILTER (WHERE ps.email_status = 'skipped')::int       AS email_skipped,
                COUNT(*) FILTER (WHERE ps.notification_status = 'sent')::int   AS notified,
                COUNT(*) FILTER (WHERE ps.notification_status = 'failed')::int AS notify_failed,
                COUNT(*) FILTER (WHERE ps.notification_status = 'pending')::int AS notify_pending
             FROM payslips ps
             JOIN payrolls p ON ps.payroll_id = p.id
             WHERE p.payroll_run_id = $1`,
            [run.id]
        ).then((r) => r.rows[0]),
    ]);

    const totalPayrolls = Object.values(statusCounts).reduce((a, b) => a + b, 0);
    const adjustmentCount = await db.query(
        `SELECT COUNT(*)::int AS count
         FROM payroll_adjustments a
         JOIN payrolls p ON a.payroll_id = p.id
         WHERE p.payroll_run_id = $1`,
        [run.id]
    ).then((r) => r.rows[0].count);

    const slips = payslipStats || {};
    const payslipsIssued = slips.total || 0;

    // Nothing left to deliver: every payslip has either landed or been
    // deliberately skipped (e.g. no email address on file).
    const emailSettled = (slips.email_pending || 0) === 0 && (slips.email_failed || 0) === 0;
    const notifySettled = (slips.notify_pending || 0) === 0 && (slips.notify_failed || 0) === 0;
    const deliveryComplete = payslipsIssued > 0 && emailSettled && notifySettled;

    // A step is complete when its output exists, not when someone clicked past
    // it — which is what lets the UI drop a returning user in the right place.
    const completion = {
        [STEP.SETUP]: true,
        [STEP.GENERATE]: totalPayrolls > 0,
        [STEP.ADJUST]: isStepAtLeast(run.current_step, STEP.REVIEW),
        [STEP.REVIEW]: isStepAtLeast(run.current_step, STEP.APPROVAL),
        [STEP.APPROVAL]: [RUN_STATUS.APPROVED, RUN_STATUS.PAID, RUN_STATUS.COMPLETED].includes(run.status),
        [STEP.PAYMENT]: [RUN_STATUS.PAID, RUN_STATUS.COMPLETED].includes(run.status),
        [STEP.PAYSLIPS]: Boolean(run.payslips_generated_at) && deliveryComplete,
        [STEP.DONE]: run.status === RUN_STATUS.COMPLETED,
    };

    // The last step is a special case. Every other step becomes reachable by
    // being completed or already passed, but 'done' is only ever completed BY
    // finishing — so keyed on completion alone it could never be reached and
    // the Finish button stayed disabled forever. It opens as soon as the run
    // is paid and delivery has settled.
    const canComplete = run.status === RUN_STATUS.PAID && deliveryComplete;

    const isReachable = (step) => {
        if (step === STEP.DONE) return canComplete || run.status === RUN_STATUS.COMPLETED;
        return completion[step] || stepIndex(step) <= stepIndex(run.current_step);
    };

    return {
        current_step: run.current_step,
        current_step_label: STEP_LABEL[run.current_step],
        current_step_index: stepIndex(run.current_step),
        steps: STEP_ORDER.map((step) => ({
            key: step,
            label: STEP_LABEL[step],
            index: stepIndex(step),
            is_complete: completion[step],
            is_current: run.current_step === step,
            // Anything already completed stays reachable, so a user can go
            // back and look without being able to break a later step.
            is_reachable: isReachable(step),
        })),

        // Single booleans the UI can bind a button's `disabled` to, instead of
        // re-deriving the rules client-side and drifting from the server.
        can_complete: canComplete,
        delivery_complete: deliveryComplete,
        pending_delivery: {
            email: (slips.email_pending || 0) + (slips.email_failed || 0),
            notifications: (slips.notify_pending || 0) + (slips.notify_failed || 0),
        },

        counts: {
            payrolls: totalPayrolls,
            by_status: statusCounts,
            adjustments: adjustmentCount,
            payslips: payslipsIssued,
            payslips_emailed: slips.emailed || 0,
            payslips_email_failed: slips.email_failed || 0,
            payslips_email_pending: slips.email_pending || 0,
            payslips_email_skipped: slips.email_skipped || 0,
            payslips_notified: slips.notified || 0,
            payslips_notify_failed: slips.notify_failed || 0,
            payslips_notify_pending: slips.notify_pending || 0,
        },
    };
}

// ============================================================
// SERVICE
// ============================================================
const PayrollRunService = {

    // ----------------------------------------------------------
    // STEP 1 — START (create or reuse the period, open the run)
    //
    // Accepts either an existing payroll_period_id or the fields to
    // create one, so "new payroll" is a single call from the UI's
    // point of view instead of create-period-then-go-find-it.
    // ----------------------------------------------------------
    async startRun(data) {
        const {
            company_id,
            user_id,
            branch_id = null,
            payroll_period_id = null,
            period_name,
            start_date,
            end_date,
            notes = null,
        } = data;

        try {
            let period;

            if (payroll_period_id) {
                period = await PayrollPeriodModel.findById(payroll_period_id);
                if (!period) return fail("Payroll period not found");
                if (period.company_id !== company_id) {
                    return fail("Payroll period does not belong to this company");
                }
                if (period.status === "locked") {
                    return fail("This payroll period is locked");
                }
            } else {
                const created = await PayrollPeriodService.createPayrollPeriod({
                    company_id, period_name, start_date, end_date,
                });
                if (!created.success) return created;
                period = created.data;
            }

            // Resuming beats duplicating: if a live run already exists for this
            // period+branch, hand it straight back rather than erroring out.
            const existing = await PayrollRunModel.findActiveByPeriod(period.id, branch_id);
            if (existing) {
                return {
                    success: true,
                    message: "An existing payroll run for this period was resumed",
                    data: await this.buildRunResponse(existing),
                    resumed: true,
                };
            }

            const run = await PayrollRunModel.create({
                company_id,
                payroll_period_id: period.id,
                branch_id,
                run_number: generateRunNumber(period.start_date),
                created_by: user_id,
                notes,
            });

            await PayrollRunModel.update(run.id, {
                status: RUN_STATUS.IN_PROGRESS,
                current_step: STEP.GENERATE,
            });

            await PayrollRunModel.logEvent({
                payroll_run_id: run.id,
                step: STEP.SETUP,
                action: RUN_ACTION.CREATED,
                from_status: null,
                to_status: RUN_STATUS.IN_PROGRESS,
                actor_user_id: user_id,
                actor_role: ACTOR_ROLE.MAKER,
                notes: `Run ${run.run_number} opened for ${period.period_name}`,
            });

            const fresh = await PayrollRunModel.findById(run.id);
            return {
                success: true,
                message: "Payroll run started",
                data: await this.buildRunResponse(fresh),
                resumed: false,
            };
        } catch (error) {
            return fail(error.message, { error });
        }
    },

    // ----------------------------------------------------------
    // STEP 2 — GENERATE
    // ----------------------------------------------------------
    async generate(run_id, { company_id, user_id, force = false }) {
        try {
            const { run, error } = await loadEditableRun(run_id, company_id);
            if (error) return error;

            const result = await PayrollService.generatePayroll({
                company_id,
                payroll_period_id: run.payroll_period_id,
                branch_id: run.branch_id,
                user_id,
                payroll_run_id: run.id,
                force,
            });
            if (!result.success) return result;

            // Payrolls created outside this run (legacy, or a direct API call)
            // are pulled in so the run's totals cover the whole period.
            await PayrollModel.attachToRun(run.id, company_id, run.payroll_period_id);

            await PayrollRunModel.update(run.id, {
                current_step: furthestStep(run.current_step, STEP.ADJUST),
                status: RUN_STATUS.IN_PROGRESS,
                generated_by: user_id,
                generated_at: new Date(),
                // A rejected run being regenerated starts its approval afresh.
                rejection_reason: null,
            });
            await PayrollRunModel.refreshTotals(run.id);

            await PayrollRunModel.logEvent({
                payroll_run_id: run.id,
                step: STEP.GENERATE,
                action: force ? RUN_ACTION.REGENERATED : RUN_ACTION.GENERATED,
                from_status: run.status,
                to_status: RUN_STATUS.IN_PROGRESS,
                actor_user_id: user_id,
                actor_role: ACTOR_ROLE.MAKER,
                notes: result.message,
                metadata: {
                    generated: result.data.generated_count,
                    skipped: result.data.skipped_count,
                    errors: result.data.error_count,
                },
            });

            const fresh = await PayrollRunModel.findById(run.id);
            return {
                success: true,
                message: result.message,
                data: {
                    ...(await this.buildRunResponse(fresh)),
                    generation: {
                        generated_count: result.data.generated_count,
                        skipped_count: result.data.skipped_count,
                        error_count: result.data.error_count,
                        skipped: result.data.skipped,
                        errors: result.data.errors,
                    },
                },
            };
        } catch (error) {
            return fail(error.message, { error });
        }
    },

    // ----------------------------------------------------------
    // STEP 3 — ADJUSTMENTS
    //
    // Adjustments themselves stay in payrollAdjustmentService; this
    // records that the step was touched and re-syncs the totals so
    // the header never lags behind the line items.
    // ----------------------------------------------------------
    async syncAdjustments(run_id, { company_id, user_id, note = null }) {
        try {
            const { run, error } = await loadEditableRun(run_id, company_id);
            if (error) return error;

            const payrolls = await PayrollModel.getAllByRun(run.id);
            for (const payroll of payrolls) {
                if (["paid", "cancelled"].includes(payroll.payroll_status)) continue;
                await PayrollService.recalculatePayroll(payroll.id);
            }

            await PayrollRunModel.update(run.id, {
                current_step: furthestStep(run.current_step, STEP.REVIEW),
            });
            await PayrollRunModel.refreshTotals(run.id);

            await PayrollRunModel.logEvent({
                payroll_run_id: run.id,
                step: STEP.ADJUST,
                action: RUN_ACTION.ADJUSTMENT_CHANGED,
                actor_user_id: user_id,
                actor_role: ACTOR_ROLE.MAKER,
                notes: note || `Recalculated ${payrolls.length} payroll(s) after adjustments`,
            });

            const fresh = await PayrollRunModel.findById(run.id);
            return {
                success: true,
                message: "Adjustments applied and totals recalculated",
                data: await this.buildRunResponse(fresh),
            };
        } catch (error) {
            return fail(error.message, { error });
        }
    },

    // ----------------------------------------------------------
    // STEP 4 → 5 — SUBMIT FOR APPROVAL (maker's last action)
    // ----------------------------------------------------------
    async submitForApproval(run_id, { company_id, user_id, notes = null }) {
        try {
            const { run, error } = await loadEditableRun(run_id, company_id);
            if (error) return error;

            const statusCounts = await PayrollModel.countByStatusForRun(run.id);
            const total = Object.values(statusCounts).reduce((a, b) => a + b, 0);
            if (total === 0) {
                return fail("Nothing to approve — generate payroll for this period first");
            }

            const settings = await PayrollSettingsModel.getOrCreate(company_id);

            // With approval switched off the run jumps straight to approved,
            // still recording who did it — a small company should not be
            // forced into two-person control, but the trail stays intact.
            if (!settings.require_approval) {
                return this._markApproved(run, {
                    user_id,
                    notes: notes || "Auto-approved — approval is disabled in payroll settings",
                    actorRole: ACTOR_ROLE.SYSTEM,
                    skipCheckerRule: true,
                });
            }

            const transitionError = assertStatusTransition(run, RUN_STATUS.PENDING_APPROVAL);
            if (transitionError) return transitionError;

            await PayrollRunModel.refreshTotals(run.id);
            await PayrollRunModel.update(run.id, {
                status: RUN_STATUS.PENDING_APPROVAL,
                current_step: STEP.APPROVAL,
                submitted_by: user_id,
                submitted_at: new Date(),
                rejected_by: null,
                rejected_at: null,
                rejection_reason: null,
            });

            await PayrollPeriodModel.updateStatus(run.payroll_period_id, "pending_approval")
                .catch(() => { /* period status is informational here */ });

            await PayrollRunModel.logEvent({
                payroll_run_id: run.id,
                step: STEP.APPROVAL,
                action: RUN_ACTION.SUBMITTED,
                from_status: run.status,
                to_status: RUN_STATUS.PENDING_APPROVAL,
                actor_user_id: user_id,
                actor_role: ACTOR_ROLE.MAKER,
                notes,
            });

            const fresh = await PayrollRunModel.findById(run.id);
            return {
                success: true,
                message: "Payroll submitted for approval",
                data: await this.buildRunResponse(fresh),
            };
        } catch (error) {
            return fail(error.message, { error });
        }
    },

    // ----------------------------------------------------------
    // STEP 5 — APPROVE (checker)
    // ----------------------------------------------------------
    async approve(run_id, { company_id, user_id, notes = null }) {
        try {
            const run = await PayrollRunModel.findById(run_id);
            if (!run) return fail("Payroll run not found");
            if (run.company_id !== company_id) return fail("Payroll run does not belong to this company");
            if (run.status !== RUN_STATUS.PENDING_APPROVAL) {
                return fail(`Only a run awaiting approval can be approved. This one is '${run.status}'.`);
            }
            return this._markApproved(run, { user_id, notes });
        } catch (error) {
            return fail(error.message, { error });
        }
    },

    /** Shared by approve() and the approval-disabled path in submitForApproval(). */
    async _markApproved(run, { user_id, notes = null, actorRole = ACTOR_ROLE.CHECKER, skipCheckerRule = false }) {
        const settings = await PayrollSettingsModel.getOrCreate(run.company_id);

        // The maker-checker rule itself: whoever prepared the payroll cannot
        // sign it off. Companies can waive it explicitly, never by accident.
        if (!skipCheckerRule && !settings.allow_self_approval) {
            const preparers = [run.submitted_by, run.generated_by, run.created_by].filter(Boolean);
            if (preparers.includes(user_id)) {
                return fail(
                    "You prepared this payroll, so you cannot approve it."
                    + " A different admin must approve, or enable self-approval in payroll settings."
                );
            }
        }

        const client = await db.getClient();
        try {
            await client.query("BEGIN");

            const bulk = await PayrollService.bulkUpdatePayrollStatus(
                run.company_id, run.payroll_period_id, "approved", { client }
            );
            if (!bulk.success) {
                await client.query("ROLLBACK");
                return bulk;
            }

            await PayrollRunModel.update(run.id, {
                status: RUN_STATUS.APPROVED,
                current_step: STEP.PAYMENT,
                approved_by: user_id,
                approved_at: new Date(),
            }, client);

            await PayrollRunModel.logEvent({
                payroll_run_id: run.id,
                step: STEP.APPROVAL,
                action: RUN_ACTION.APPROVED,
                from_status: run.status,
                to_status: RUN_STATUS.APPROVED,
                actor_user_id: user_id,
                actor_role: actorRole,
                notes,
                metadata: { approved_count: bulk.data.updated_count },
            }, client);

            await client.query("COMMIT");

            await PayrollRunModel.refreshTotals(run.id);
            await PayrollPeriodModel.updateStatus(run.payroll_period_id, "approved").catch(() => { });

            const fresh = await PayrollRunModel.findById(run.id);
            return {
                success: true,
                message: `Payroll approved — ${bulk.data.updated_count} employee record(s)`,
                data: await this.buildRunResponse(fresh),
            };
        } catch (error) {
            await client.query("ROLLBACK").catch(() => { });
            return fail(error.message, { error });
        } finally {
            client.release();
        }
    },

    // ----------------------------------------------------------
    // STEP 5 — REJECT (checker sends it back to the maker)
    // ----------------------------------------------------------
    async reject(run_id, { company_id, user_id, reason }) {
        try {
            if (!reason || !String(reason).trim()) {
                return fail("A rejection reason is required so the preparer knows what to fix");
            }

            const run = await PayrollRunModel.findById(run_id);
            if (!run) return fail("Payroll run not found");
            if (run.company_id !== company_id) return fail("Payroll run does not belong to this company");
            if (run.status !== RUN_STATUS.PENDING_APPROVAL) {
                return fail(`Only a run awaiting approval can be rejected. This one is '${run.status}'.`);
            }

            await PayrollRunModel.update(run.id, {
                status: RUN_STATUS.REJECTED,
                // Back to adjustments — that is where a correction starts.
                current_step: STEP.ADJUST,
                rejected_by: user_id,
                rejected_at: new Date(),
                rejection_reason: String(reason).trim(),
            });

            await PayrollPeriodModel.updateStatus(run.payroll_period_id, "processing").catch(() => { });

            await PayrollRunModel.logEvent({
                payroll_run_id: run.id,
                step: STEP.APPROVAL,
                action: RUN_ACTION.REJECTED,
                from_status: run.status,
                to_status: RUN_STATUS.REJECTED,
                actor_user_id: user_id,
                actor_role: ACTOR_ROLE.CHECKER,
                notes: String(reason).trim(),
            });

            const fresh = await PayrollRunModel.findById(run.id);
            return {
                success: true,
                message: "Payroll rejected and sent back for correction",
                data: await this.buildRunResponse(fresh),
            };
        } catch (error) {
            return fail(error.message, { error });
        }
    },

    /**
     * What the payment confirmation dialog needs before anyone commits:
     * the totals about to be disbursed, and how many people can actually
     * be reached by email and on their phones.
     */
    async getPaymentSummary(run_id, company_id) {
        try {
            const run = await PayrollRunModel.findById(run_id);
            if (!run) return fail("Payroll run not found");
            if (run.company_id !== company_id) return fail("Payroll run does not belong to this company");

            const [payrolls, settings] = await Promise.all([
                PayrollModel.getAllByRun(run.id),
                PayrollSettingsModel.getOrCreate(company_id),
            ]);

            const payable = payrolls.filter((p) => p.payroll_status === "approved");
            const withoutEmail = payable.filter((p) => !p.employee_email);

            return {
                success: true,
                data: {
                    run_id: run.id,
                    period_name: run.period_name,
                    employee_count: payable.length,
                    total_net: payable.reduce((t, p) => t + (parseFloat(p.net_salary) || 0), 0).toFixed(2),
                    total_gross: payable.reduce((t, p) => t + (parseFloat(p.gross_salary) || 0), 0).toFixed(2),
                    // Surfaced up front so the dialog can warn before paying,
                    // not after the emails have already been attempted.
                    employees_without_email: withoutEmail.length,
                    employees_without_email_list: withoutEmail.map((p) => ({
                        employee_id: p.employee_id,
                        employee_code: p.employee_code,
                        name: `${p.employee_first_name || ""} ${p.employee_last_name || ""}`.trim(),
                    })),
                    not_payable_count: payrolls.length - payable.length,
                    defaults: {
                        send_payslip_email: settings.auto_email_payslips,
                        notify_employees: true,
                    },
                },
            };
        } catch (error) {
            return fail(error.message, { error });
        }
    },

    // ----------------------------------------------------------
    // STEP 6 — PAY
    //
    // The confirmation dialog's answers arrive as flags. Payslips are
    // issued, emailed and pushed in the same call so "paid" and
    // "everyone was told" cannot drift apart.
    //
    // Delivery runs AFTER the payment transaction commits, and its
    // failures are reported rather than thrown: a bounced email must
    // never roll back money that has already been paid.
    //
    // @param {boolean} opts.send_payslip_email  email the payslips
    // @param {boolean} opts.notify_employees    push + in-app notification
    // ----------------------------------------------------------
    async markAsPaid(run_id, {
        company_id,
        user_id,
        notes = null,
        send_payslip_email = null,
        notify_employees = true,
    }) {
        const client = await db.getClient();
        try {
            const run = await PayrollRunModel.findById(run_id);
            if (!run) return fail("Payroll run not found");
            if (run.company_id !== company_id) return fail("Payroll run does not belong to this company");

            const transitionError = assertStatusTransition(run, RUN_STATUS.PAID);
            if (transitionError) return transitionError;

            await client.query("BEGIN");

            const bulk = await PayrollService.bulkUpdatePayrollStatus(
                run.company_id, run.payroll_period_id, "paid", { client }
            );
            if (!bulk.success) {
                await client.query("ROLLBACK");
                return bulk;
            }

            await PayrollRunModel.update(run.id, {
                status: RUN_STATUS.PAID,
                current_step: STEP.PAYSLIPS,
                paid_by: user_id,
                paid_at: new Date(),
            }, client);

            await PayrollRunModel.logEvent({
                payroll_run_id: run.id,
                step: STEP.PAYMENT,
                action: RUN_ACTION.PAID,
                from_status: run.status,
                to_status: RUN_STATUS.PAID,
                actor_user_id: user_id,
                actor_role: ACTOR_ROLE.CHECKER,
                notes,
                metadata: { paid_count: bulk.data.updated_count },
            }, client);

            await client.query("COMMIT");

            await PayrollRunModel.refreshTotals(run.id);
            await PayrollPeriodModel.updateStatus(run.payroll_period_id, "completed").catch(() => { });

            // ── Post-payment delivery ────────────────────────
            // Past this point the money is paid and committed. Everything
            // below reports its outcome instead of failing the request —
            // each part is separately retryable from the payslips step.
            const settings = await PayrollSettingsModel.getOrCreate(company_id);
            const shouldEmail = send_payslip_email === null
                ? settings.auto_email_payslips
                : send_payslip_email === true;

            const delivery = { payslips: null, email: null, notifications: null };

            if (shouldEmail || notify_employees) {
                const issued = await PayslipService.generatePayslipsForPeriod(
                    company_id, run.payroll_period_id, { payroll_run_id: run.id }
                );
                delivery.payslips = issued.success ? issued.data : { error: issued.message };

                if (issued.success) {
                    await PayrollRunModel.update(run.id, { payslips_generated_at: new Date() });
                    await PayrollRunModel.logEvent({
                        payroll_run_id: run.id,
                        step: STEP.PAYSLIPS,
                        action: RUN_ACTION.PAYSLIPS_GENERATED,
                        actor_user_id: user_id,
                        actor_role: ACTOR_ROLE.SYSTEM,
                        notes: issued.message,
                    });
                }
            }

            if (shouldEmail) {
                const emailed = await PayslipService.emailPayslipsForRun(run.id);
                delivery.email = emailed.success ? emailed.data : { error: emailed.message };

                if (emailed.success) {
                    await PayrollRunModel.update(run.id, { payslips_sent_at: new Date() });
                    await PayrollRunModel.logEvent({
                        payroll_run_id: run.id,
                        step: STEP.PAYSLIPS,
                        action: RUN_ACTION.PAYSLIPS_SENT,
                        actor_user_id: user_id,
                        actor_role: ACTOR_ROLE.SYSTEM,
                        notes: emailed.message,
                        metadata: { sent: emailed.data.sent_count, failed: emailed.data.failed_count },
                    });
                }
            }

            if (notify_employees) {
                const notified = await PayslipService.notifyPayslipsForRun(run.id);
                delivery.notifications = notified.success ? notified.data : { error: notified.message };

                if (notified.success) {
                    await PayrollRunModel.logEvent({
                        payroll_run_id: run.id,
                        step: STEP.PAYSLIPS,
                        action: RUN_ACTION.EMPLOYEES_NOTIFIED,
                        actor_user_id: user_id,
                        actor_role: ACTOR_ROLE.SYSTEM,
                        notes: notified.message,
                        metadata: { notified: notified.data.notified_count, failed: notified.data.failed_count },
                    });
                }
            }

            // Delivery just ran inline; if it all landed the run is ready to close.
            await maybeAdvanceToDone(run.id);

            const fresh = await PayrollRunModel.findById(run.id);
            const parts = [`${bulk.data.updated_count} payroll(s) marked as paid`];
            if (delivery.email) parts.push(`${delivery.email.sent_count ?? 0} payslip(s) emailed`);
            if (delivery.notifications) parts.push(`${delivery.notifications.notified_count ?? 0} employee(s) notified`);

            return {
                success: true,
                message: parts.join(", "),
                data: { ...(await this.buildRunResponse(fresh)), delivery },
            };
        } catch (error) {
            await client.query("ROLLBACK").catch(() => { });
            return fail(error.message, { error });
        } finally {
            client.release();
        }
    },

    /**
     * Notify employees separately — for a run paid without notifications,
     * or to retry the ones that failed.
     */
    async notifyEmployees(run_id, { company_id, user_id, only_failed = false }) {
        try {
            const run = await PayrollRunModel.findById(run_id);
            if (!run) return fail("Payroll run not found");
            if (run.company_id !== company_id) return fail("Payroll run does not belong to this company");
            if (!run.payslips_generated_at) {
                return fail("Generate the payslips before notifying employees");
            }

            const result = await PayslipService.notifyPayslipsForRun(run.id, { only_failed });
            if (!result.success) return result;

            await maybeAdvanceToDone(run.id);

            await PayrollRunModel.logEvent({
                payroll_run_id: run.id,
                step: STEP.PAYSLIPS,
                action: RUN_ACTION.EMPLOYEES_NOTIFIED,
                actor_user_id: user_id,
                actor_role: ACTOR_ROLE.MAKER,
                notes: result.message,
                metadata: { notified: result.data.notified_count, failed: result.data.failed_count },
            });

            const fresh = await PayrollRunModel.findById(run.id);
            return {
                success: true,
                message: result.message,
                data: { ...(await this.buildRunResponse(fresh)), notifications: result.data },
            };
        } catch (error) {
            return fail(error.message, { error });
        }
    },

    // ----------------------------------------------------------
    // STEP 7 — PAYSLIPS (generate, then email)
    // ----------------------------------------------------------
    async generatePayslips(run_id, { company_id, user_id }) {
        try {
            const run = await PayrollRunModel.findById(run_id);
            if (!run) return fail("Payroll run not found");
            if (run.company_id !== company_id) return fail("Payroll run does not belong to this company");
            if (![RUN_STATUS.PAID, RUN_STATUS.COMPLETED].includes(run.status)) {
                return fail("Payslips can only be issued once the payroll has been paid");
            }

            const result = await PayslipService.generatePayslipsForPeriod(
                company_id, run.payroll_period_id, { payroll_run_id: run.id }
            );
            if (!result.success) return result;

            await PayrollRunModel.update(run.id, {
                payslips_generated_at: new Date(),
                current_step: STEP.PAYSLIPS,
            });

            await PayrollRunModel.logEvent({
                payroll_run_id: run.id,
                step: STEP.PAYSLIPS,
                action: RUN_ACTION.PAYSLIPS_GENERATED,
                actor_user_id: user_id,
                actor_role: ACTOR_ROLE.MAKER,
                notes: result.message,
                metadata: { generated: result.data.generated_count, skipped: result.data.skipped_count },
            });

            const fresh = await PayrollRunModel.findById(run.id);
            return {
                success: true,
                message: result.message,
                data: { ...(await this.buildRunResponse(fresh)), payslips: result.data },
            };
        } catch (error) {
            return fail(error.message, { error });
        }
    },

    /**
     * Email the payslips. Retryable by design: only 'pending' and 'failed'
     * payslips are attempted, so a partial send can be resumed without
     * spamming everyone who already received theirs.
     */
    async emailPayslips(run_id, { company_id, user_id, only_failed = false }) {
        try {
            const run = await PayrollRunModel.findById(run_id);
            if (!run) return fail("Payroll run not found");
            if (run.company_id !== company_id) return fail("Payroll run does not belong to this company");
            if (!run.payslips_generated_at) {
                return fail("Generate the payslips before sending them");
            }

            const result = await PayslipService.emailPayslipsForRun(run.id, { only_failed });
            if (!result.success) return result;

            await PayrollRunModel.update(run.id, { payslips_sent_at: new Date() });
            // "Nothing left to send" counts as settled. Gating on sent_count > 0
            // meant a re-run after everything had already gone out never advanced
            // the step, and the run sat on `payslips` forever with Finish disabled.
            await maybeAdvanceToDone(run.id);

            await PayrollRunModel.logEvent({
                payroll_run_id: run.id,
                step: STEP.PAYSLIPS,
                action: RUN_ACTION.PAYSLIPS_SENT,
                actor_user_id: user_id,
                actor_role: ACTOR_ROLE.MAKER,
                notes: result.message,
                metadata: { sent: result.data.sent_count, failed: result.data.failed_count },
            });

            const fresh = await PayrollRunModel.findById(run.id);
            return {
                success: true,
                message: result.message,
                data: { ...(await this.buildRunResponse(fresh)), email: result.data },
            };
        } catch (error) {
            return fail(error.message, { error });
        }
    },

    // ----------------------------------------------------------
    // STEP 8 — COMPLETE (locks the period)
    // ----------------------------------------------------------
    async complete(run_id, { company_id, user_id }) {
        try {
            const run = await PayrollRunModel.findById(run_id);
            if (!run) return fail("Payroll run not found");
            if (run.company_id !== company_id) return fail("Payroll run does not belong to this company");

            const transitionError = assertStatusTransition(run, RUN_STATUS.COMPLETED);
            if (transitionError) return transitionError;

            await PayrollRunModel.update(run.id, {
                status: RUN_STATUS.COMPLETED,
                current_step: STEP.DONE,
                completed_at: new Date(),
            });

            await PayrollPeriodModel.lock(run.payroll_period_id).catch(() => { });

            await PayrollRunModel.logEvent({
                payroll_run_id: run.id,
                step: STEP.DONE,
                action: RUN_ACTION.COMPLETED,
                from_status: run.status,
                to_status: RUN_STATUS.COMPLETED,
                actor_user_id: user_id,
                actor_role: ACTOR_ROLE.CHECKER,
            });

            const fresh = await PayrollRunModel.findById(run.id);
            return {
                success: true,
                message: "Payroll run completed and the period is now locked",
                data: await this.buildRunResponse(fresh),
            };
        } catch (error) {
            return fail(error.message, { error });
        }
    },

    // ----------------------------------------------------------
    // CANCEL
    // ----------------------------------------------------------
    async cancel(run_id, { company_id, user_id, reason = null }) {
        try {
            const run = await PayrollRunModel.findById(run_id);
            if (!run) return fail("Payroll run not found");
            if (run.company_id !== company_id) return fail("Payroll run does not belong to this company");

            const transitionError = assertStatusTransition(run, RUN_STATUS.CANCELLED);
            if (transitionError) return transitionError;

            await PayrollRunModel.update(run.id, {
                status: RUN_STATUS.CANCELLED,
                cancelled_by: user_id,
                cancelled_at: new Date(),
            });

            await PayrollService.bulkUpdatePayrollStatus(
                run.company_id, run.payroll_period_id, "cancelled"
            );

            await PayrollRunModel.logEvent({
                payroll_run_id: run.id,
                step: run.current_step,
                action: RUN_ACTION.CANCELLED,
                from_status: run.status,
                to_status: RUN_STATUS.CANCELLED,
                actor_user_id: user_id,
                actor_role: ACTOR_ROLE.CHECKER,
                notes: reason,
            });

            return {
                success: true,
                message: "Payroll run cancelled",
                data: await PayrollRunModel.findById(run.id),
            };
        } catch (error) {
            return fail(error.message, { error });
        }
    },

    // ----------------------------------------------------------
    // READS
    // ----------------------------------------------------------

    /**
     * "Continue where you left off." Returns every unfinished run plus
     * the one the UI should open by default.
     */
    async getResumable(company_id, branch_id = null) {
        try {
            const runs = await PayrollRunModel.getResumable(company_id, branch_id);
            const detailed = await Promise.all(runs.map(async (run) => ({
                ...run,
                progress: await buildProgress(run),
            })));

            return {
                success: true,
                data: {
                    // Most recent period first — that is what someone
                    // returning to the screen almost always wants.
                    active_run: detailed[0] || null,
                    runs: detailed,
                    has_unfinished_run: detailed.length > 0,
                },
            };
        } catch (error) {
            return fail(error.message, { error });
        }
    },

    async getRunById(run_id, company_id) {
        try {
            const run = await PayrollRunModel.findById(run_id);
            if (!run) return fail("Payroll run not found");
            if (run.company_id !== company_id) return fail("Payroll run does not belong to this company");
            return { success: true, data: await this.buildRunResponse(run, { includeEmployees: true }) };
        } catch (error) {
            return fail(error.message, { error });
        }
    },

    async getRuns(company_id, options = {}) {
        try {
            const runs = await PayrollRunModel.getAllByCompany(company_id, options);
            return { success: true, data: runs };
        } catch (error) {
            return fail(error.message, { error });
        }
    },

    async getPendingApprovals(company_id) {
        try {
            const runs = await PayrollRunModel.getPendingApproval(company_id);
            const detailed = await Promise.all(runs.map(async (run) => ({
                ...run,
                progress: await buildProgress(run),
            })));
            return { success: true, data: detailed };
        } catch (error) {
            return fail(error.message, { error });
        }
    },

    async getTimeline(run_id, company_id) {
        try {
            const run = await PayrollRunModel.findById(run_id);
            if (!run) return fail("Payroll run not found");
            if (run.company_id !== company_id) return fail("Payroll run does not belong to this company");
            return { success: true, data: await PayrollRunModel.getEvents(run_id) };
        } catch (error) {
            return fail(error.message, { error });
        }
    },

    /** Everything a wizard screen needs in one payload. */
    async buildRunResponse(run, { includeEmployees = false } = {}) {
        const progress = await buildProgress(run);

        const response = {
            ...run,
            progress,
            maker_checker: {
                prepared_by: run.generated_by_name || run.created_by_name || null,
                submitted_by: run.submitted_by_name || null,
                submitted_at: run.submitted_at,
                approved_by: run.approved_by_name || null,
                approved_at: run.approved_at,
                rejected_by: run.rejected_by_name || null,
                rejected_at: run.rejected_at,
                rejection_reason: run.rejection_reason,
                paid_by: run.paid_by_name || null,
                paid_at: run.paid_at,
            },
        };

        if (includeEmployees) {
            const payrolls = await PayrollModel.getAllByRun(run.id);
            response.employees = await Promise.all(payrolls.map(async (p) => {
                const adjustments = await PayrollAdjustmentModel.getAllByPayroll(p.id);
                const figures = PayrollService.computeFinalFigures(p, adjustments);
                const payslip = await PayslipModel.findByPayrollId(p.id);
                return {
                    ...p,
                    // `id` here is the payroll id, but every other endpoint calls
                    // it payroll_id (the breakdown route takes /:payroll_id).
                    // Exposing both means a caller reaching for the obvious name
                    // gets a value instead of `undefined` in a URL.
                    payroll_id: p.id,
                    employee_name: `${p.employee_first_name || ""} ${p.employee_last_name || ""}`.trim(),
                    adjustments,
                    preview_bonus: figures.bonus_amount,
                    preview_deduction: figures.deduction_amount,
                    preview_net_salary: figures.net_salary,
                    payslip: payslip || null,
                    // Flattened so the per-employee delivery column does not
                    // have to reach through a possibly-null payslip object.
                    payslip_id: payslip?.id || null,
                    payslip_number: payslip?.payslip_number || null,
                    email_status: payslip?.email_status || null,
                    email_sent_at: payslip?.email_sent_at || null,
                    email_error: payslip?.email_error || null,
                    notification_status: payslip?.notification_status || null,
                    notified_at: payslip?.notified_at || null,
                    has_email: Boolean(p.employee_email),
                };
            }));
        }

        return response;
    },

    // ----------------------------------------------------------
    // SETTINGS
    // ----------------------------------------------------------
    async getSettings(company_id) {
        try {
            return { success: true, data: await PayrollSettingsModel.getOrCreate(company_id) };
        } catch (error) {
            return fail(error.message, { error });
        }
    },

    async updateSettings(company_id, data) {
        try {
            await PayrollSettingsModel.getOrCreate(company_id);
            const updated = await PayrollSettingsModel.update(company_id, data);
            return {
                success: true,
                message: "Payroll settings updated."
                    + " Changes apply the next time payroll is generated — existing runs keep their frozen figures.",
                data: updated,
            };
        } catch (error) {
            return fail(error.message, { error });
        }
    },
};

module.exports = PayrollRunService;
