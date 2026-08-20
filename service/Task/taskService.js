const db = require("../../config/database");

const { TaskModel } = require("../../models/Task/taskModel");
const { TaskCategoryModel } = require("../../models/Task/taskCategoryModel");
const {
    TaskStatusHistory,
    TaskComment,
    TaskWatcher,
} = require("../../models/Task/taskActivityModel");

const Employee = require("../../models/employeeModel");
const Department = require("../../models/departmentModel");

const TaskAccessService = require("./taskAccessService");
const TaskNotificationService = require("./taskNotificationService");

const {
    TaskStatus,
    TaskStatusLabel,
    EMPLOYEE_ALLOWED_TARGETS,
    canTransition,
    isValidStatus,
    ALLOWED_TRANSITIONS,
} = require("../../enums/Task/taskStatus");
const {
    TaskPriority,
    DEFAULT_PRIORITY,
    isValidPriority,
} = require("../../enums/Task/taskPriority");
const { parseDueAt, zoneOf, isOverdue } = require("../../utils/Task/taskTime");

/**
 * The task module's write path.
 *
 * Two invariants hold everywhere in this file:
 *
 *   1. Authorization is never inferred from the request body. The actor is
 *      resolved from the token (taskAccessService.resolveActor) and the target
 *      is read from the database; a department_id or employee_id in the
 *      payload is data to be validated, never a claim to be trusted.
 *
 *   2. A status never moves without a task_status_history row, and the two
 *      are written in the same transaction. The performance dashboard reads
 *      the history table — a transition that failed to log is a task that
 *      silently never happened as far as the numbers are concerned.
 */

const fullName = (employee) =>
    employee ? `${employee.first_name} ${employee.last_name}`.trim() : null;

/**
 * Everyone who should hear about a change to this task: the assignee plus
 * the registered watchers (assigner and HOD, added at creation).
 */
const audienceFor = async (task) => {
    const watchers = await TaskWatcher.findEmployeeIds(task.id);
    return [...new Set([task.assigned_to_employee_id, ...watchers].filter(Boolean))];
};

const TaskService = {
    // ─────────────────────────────────────────────────────────────────────
    // CREATE
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Assign a task.
     *
     * department_id is taken from the ASSIGNEE's employee record and frozen
     * onto the task, not accepted from the caller: it is both the HOD
     * permission boundary and the dashboard's grouping key, so it has to
     * describe reality at the moment of assignment.
     */
    async createTask({ company_id, user, data, actor: cachedActor = null }) {
        try {
            const resolved = await TaskAccessService.ensureActor(user, company_id, cachedActor);
            if (!resolved.success) return { success: false, message: resolved.message };
            const { actor } = resolved;

            if (!actor.is_admin && !actor.is_hod) {
                return {
                    success: false,
                    status: 403,
                    message: "Only an admin or a head of department can assign tasks.",
                };
            }

            const {
                title,
                description = null,
                category_id = null,
                assigned_to_employee_id,
                priority = DEFAULT_PRIORITY,
                due_at = null,
                due_timezone = null,
                branch_id = null,
                watcher_employee_ids = [],
            } = data;

            if (!title || !String(title).trim()) {
                return { success: false, message: "title is required" };
            }
            if (!assigned_to_employee_id) {
                return { success: false, message: "assigned_to_employee_id is required" };
            }
            if (!isValidPriority(priority)) {
                return {
                    success: false,
                    message: `priority must be one of: ${Object.values(TaskPriority).join(", ")}`,
                };
            }

            // ── The assignee, and whether this actor may reach them ────────
            const assignee = await Employee.findById(assigned_to_employee_id);
            const permission = TaskAccessService.canAssignTo(actor, assignee);
            if (!permission.allowed) {
                return { success: false, status: permission.status, message: permission.message };
            }

            // ── Category must belong to this company ───────────────────────
            if (category_id) {
                const category = await TaskCategoryModel.findById(category_id);
                if (!category || category.company_id !== company_id) {
                    return { success: false, message: "Task category not found for this company." };
                }
                if (!category.is_active) {
                    return { success: false, message: `Category "${category.name}" is inactive.` };
                }
            }

            // ── Deadline ───────────────────────────────────────────────────
            // A bare date or a zoneless time means local time where the work
            // happens. Resolving it against the company timezone here is what
            // makes "one day before the deadline" mean the same thing to the
            // job, the employee and the admin who set it.
            const company = await db.query(
                `SELECT timezone FROM companies WHERE id = $1`, [company_id]
            );
            const zone = zoneOf(due_timezone || company.rows[0]?.timezone);

            let parsedDue = null;
            if (due_at) {
                parsedDue = parseDueAt(due_at, zone);
                if (!parsedDue) {
                    return { success: false, message: "due_at is not a valid date/time." };
                }
                if (parsedDue.getTime() < Date.now()) {
                    return { success: false, message: "The deadline is in the past." };
                }
            }

            const client = await db.getClient();
            let task;

            try {
                await client.query("BEGIN");

                task = await TaskModel.create({
                    company_id,
                    branch_id: branch_id || assignee.branch_id || null,
                    category_id,
                    department_id: assignee.department_id || null,
                    assigned_to_employee_id,
                    assigned_by_employee_id: actor.employee_id,
                    title: String(title).trim(),
                    description,
                    priority,
                    status: TaskStatus.OPEN,
                    due_at: parsedDue,
                    due_timezone: parsedDue ? zone : null,
                    created_by_user_id: actor.user_id,
                }, client);

                // The creation row. from_status is NULL — the rollup reads
                // this as "assigned on this day".
                await TaskStatusHistory.create({
                    task_id: task.id,
                    company_id,
                    from_status: null,
                    to_status: TaskStatus.OPEN,
                    remark: "Task created",
                    changed_by_employee_id: actor.employee_id,
                    changed_by_role: TaskAccessService.actingRoleOf(actor),
                }, client);

                // Watchers: whoever raised it, the assignee's HOD, and anyone
                // the caller named. Resolved once here so later status changes
                // do not have to walk the reporting line again.
                const hod = assignee.department_id
                    ? await Department.findById(assignee.department_id)
                    : null;

                await TaskWatcher.addMany(task.id, [
                    actor.employee_id,
                    hod?.head_employee_id,
                    ...watcher_employee_ids,
                ], client);

                await client.query("COMMIT");
            } catch (error) {
                await client.query("ROLLBACK");
                throw error;
            } finally {
                client.release();
            }

            const created = await TaskModel.findById(task.id, company_id);

            // Best-effort, outside the transaction and deliberately not
            // awaited into the response: a push that fails must not roll back
            // an assignment that already happened.
            TaskNotificationService.notifyAssigned({
                task: created,
                assigned_by_name: fullName(actor.employee),
            }).catch((err) =>
                console.error("[Notification] task_assigned failed:", err.message)
            );

            return { success: true, message: "Task assigned successfully", data: created };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ─────────────────────────────────────────────────────────────────────
    // READ
    // ─────────────────────────────────────────────────────────────────────

    async getTaskById({ company_id, user, task_id, actor: cachedActor = null }) {
        try {
            const resolved = await TaskAccessService.ensureActor(user, company_id, cachedActor);
            if (!resolved.success) return { success: false, message: resolved.message };
            const { actor } = resolved;

            const task = await TaskModel.findById(task_id, company_id);
            const permission = TaskAccessService.canView(actor, task);
            if (!permission.allowed) {
                return { success: false, status: permission.status, message: permission.message };
            }

            const [history, comments, watchers] = await Promise.all([
                TaskStatusHistory.findByTask(task_id),
                TaskComment.findByTask(task_id),
                TaskWatcher.findEmployeeIds(task_id),
            ]);

            return {
                success: true,
                data: {
                    ...task,
                    status_label: TaskStatusLabel[task.status],
                    // The frontend renders the status dropdown from this, so a
                    // rule change here never needs a matching client release.
                    allowed_transitions: TaskService._allowedTransitionsFor(actor, task),
                    can_edit: TaskAccessService.canEdit(actor, task).allowed,
                    history,
                    comments,
                    watcher_employee_ids: watchers,
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async listTasks({ company_id, user, filters = {}, actor: cachedActor = null }) {
        try {
            const resolved = await TaskAccessService.ensureActor(user, company_id, cachedActor);
            if (!resolved.success) return { success: false, message: resolved.message };
            const { actor } = resolved;

            if (!actor.is_admin && !actor.employee_id) {
                return {
                    success: false,
                    status: 403,
                    message: "No employee profile in this company, so there are no tasks to show.",
                };
            }

            const scope = TaskAccessService.listScopeFor(actor);
            const result = await TaskModel.list(company_id, { ...filters, scope });

            return {
                success: true,
                data: result.tasks,
                pagination: {
                    page: result.page,
                    limit: result.limit,
                    total: result.total,
                    totalPages: Math.ceil(result.total / result.limit),
                },
                meta: { scope: actor.scope },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    /** Status counters for whatever this actor is allowed to see. */
    async getSummary({ company_id, user, actor: cachedActor = null }) {
        try {
            const resolved = await TaskAccessService.ensureActor(user, company_id, cachedActor);
            if (!resolved.success) return { success: false, message: resolved.message };
            const { actor } = resolved;

            const rows = await TaskModel.countsByStatus(company_id, TaskAccessService.listScopeFor(actor));

            const byStatus = Object.values(TaskStatus).reduce((acc, s) => ({ ...acc, [s]: 0 }), {});
            let total = 0;
            let overdue = 0;

            for (const row of rows) {
                byStatus[row.status] = row.count;
                total += row.count;
                overdue += row.overdue_count;
            }

            return {
                success: true,
                data: {
                    total,
                    overdue,
                    by_status: byStatus,
                    scope: actor.scope,
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ─────────────────────────────────────────────────────────────────────
    // UPDATE — the terms of the task
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Admin/HOD only. Reassignment is handled here rather than in its own
     * endpoint because it is the same permission question, but it drags two
     * side effects with it: the frozen department_id has to follow the new
     * assignee, and the new assignee has to be told.
     */
    async updateTask({ company_id, user, task_id, data, actor: cachedActor = null }) {
        try {
            const resolved = await TaskAccessService.ensureActor(user, company_id, cachedActor);
            if (!resolved.success) return { success: false, message: resolved.message };
            const { actor } = resolved;

            const task = await TaskModel.findById(task_id, company_id);
            const permission = TaskAccessService.canEdit(actor, task);
            if (!permission.allowed) {
                return { success: false, status: permission.status, message: permission.message };
            }

            if (task.status === TaskStatus.CANCELLED) {
                return { success: false, message: "A cancelled task cannot be edited. Reopen it first." };
            }

            const patch = {};

            if (data.title !== undefined) {
                if (!String(data.title).trim()) return { success: false, message: "title cannot be empty" };
                patch.title = String(data.title).trim();
            }
            if (data.description !== undefined) patch.description = data.description;

            if (data.priority !== undefined) {
                if (!isValidPriority(data.priority)) {
                    return {
                        success: false,
                        message: `priority must be one of: ${Object.values(TaskPriority).join(", ")}`,
                    };
                }
                patch.priority = data.priority;
            }

            if (data.category_id !== undefined) {
                if (data.category_id) {
                    const category = await TaskCategoryModel.findById(data.category_id);
                    if (!category || category.company_id !== company_id) {
                        return { success: false, message: "Task category not found for this company." };
                    }
                }
                patch.category_id = data.category_id || null;
            }

            // ── Reassignment ───────────────────────────────────────────────
            let reassignedTo = null;
            if (data.assigned_to_employee_id && data.assigned_to_employee_id !== task.assigned_to_employee_id) {
                const assignee = await Employee.findById(data.assigned_to_employee_id);
                const assignPermission = TaskAccessService.canAssignTo(actor, assignee);
                if (!assignPermission.allowed) {
                    return { success: false, status: assignPermission.status, message: assignPermission.message };
                }
                patch.assigned_to_employee_id = assignee.id;
                patch.department_id = assignee.department_id || null;
                patch.branch_id = assignee.branch_id || task.branch_id;
                reassignedTo = assignee;
            }

            // ── Deadline ───────────────────────────────────────────────────
            if (data.due_at !== undefined) {
                if (data.due_at === null) {
                    patch.due_at = null;
                    patch.due_timezone = null;
                } else {
                    const zone = zoneOf(data.due_timezone || task.due_timezone || task.company_timezone);
                    const parsed = parseDueAt(data.due_at, zone);
                    if (!parsed) return { success: false, message: "due_at is not a valid date/time." };
                    patch.due_at = parsed;
                    patch.due_timezone = zone;
                }
            }

            if (!Object.keys(patch).length) {
                return { success: false, message: "Nothing to update." };
            }

            await TaskModel.update(task_id, patch);
            const updated = await TaskModel.findById(task_id, company_id);

            if (reassignedTo) {
                // The new assignee joins the watcher list; the old one stays
                // on it, because someone who worked on a task generally wants
                // to know how it ended.
                await TaskWatcher.addMany(task_id, [reassignedTo.id]);

                TaskNotificationService.notifyAssigned({
                    task: updated,
                    assigned_by_name: fullName(actor.employee),
                    is_reassignment: true,
                }).catch((err) =>
                    console.error("[Notification] task_reassigned failed:", err.message)
                );
            }

            return { success: true, message: "Task updated successfully", data: updated };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ─────────────────────────────────────────────────────────────────────
    // UPDATE — status
    // ─────────────────────────────────────────────────────────────────────

    /**
     * The status machine.
     *
     * Three gates, in order: may this actor touch the task at all, is the
     * transition legal for anybody, and is it legal for THIS actor. The third
     * is what stops an employee marking their own overdue work `completed` —
     * see EMPLOYEE_ALLOWED_TARGETS.
     */
    async changeStatus({ company_id, user, task_id, status, remark = null, actor: cachedActor = null }) {
        try {
            const resolved = await TaskAccessService.ensureActor(user, company_id, cachedActor);
            if (!resolved.success) return { success: false, message: resolved.message };
            const { actor } = resolved;

            const task = await TaskModel.findById(task_id, company_id);
            const permission = TaskAccessService.canChangeStatus(actor, task);
            if (!permission.allowed) {
                return { success: false, status: permission.status, message: permission.message };
            }

            if (!isValidStatus(status)) {
                return {
                    success: false,
                    message: `status must be one of: ${Object.values(TaskStatus).join(", ")}`,
                };
            }
            if (status === task.status) {
                return { success: false, message: `Task is already ${TaskStatusLabel[status]}.` };
            }
            if (!canTransition(task.status, status)) {
                return {
                    success: false,
                    message: `A ${TaskStatusLabel[task.status]} task cannot move to ${TaskStatusLabel[status]}.`,
                };
            }
            if (!permission.as_manager && !EMPLOYEE_ALLOWED_TARGETS.includes(status)) {
                return {
                    success: false,
                    status: 403,
                    message:
                        status === TaskStatus.COMPLETED
                            ? "Submit the task for review — your head of department or an admin signs it off."
                            : `You cannot move a task to ${TaskStatusLabel[status]}.`,
                };
            }

            const previous_status = task.status;
            const client = await db.getClient();
            let updated;

            try {
                await client.query("BEGIN");

                updated = await TaskModel.applyStatus(task_id, status, client);

                await TaskStatusHistory.create({
                    task_id,
                    company_id,
                    from_status: previous_status,
                    to_status: status,
                    remark,
                    changed_by_employee_id: actor.employee_id,
                    changed_by_role: TaskAccessService.actingRoleOf(actor),
                    // Frozen now: an admin who later extends the deadline must
                    // not retroactively turn a late delivery into an on-time one.
                    was_overdue: isOverdue(task.due_at),
                }, client);

                await client.query("COMMIT");
            } catch (error) {
                await client.query("ROLLBACK");
                throw error;
            } finally {
                client.release();
            }

            const fresh = await TaskModel.findById(task_id, company_id);

            const recipients = await audienceFor(fresh);
            TaskNotificationService.notifyStatusChange({
                task: fresh,
                previous_status,
                actor_name: fullName(actor.employee),
                actor_employee_id: actor.employee_id,
                remark,
                recipient_employee_ids: recipients,
            }).catch((err) =>
                console.error("[Notification] task_status_update failed:", err.message)
            );

            return {
                success: true,
                message: `Task moved to ${TaskStatusLabel[status]}`,
                data: fresh,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ─────────────────────────────────────────────────────────────────────
    // COMMENTS
    // ─────────────────────────────────────────────────────────────────────

    async addComment({ company_id, user, task_id, comment, actor: cachedActor = null }) {
        try {
            const resolved = await TaskAccessService.ensureActor(user, company_id, cachedActor);
            if (!resolved.success) return { success: false, message: resolved.message };
            const { actor } = resolved;

            if (!comment || !String(comment).trim()) {
                return { success: false, message: "comment is required" };
            }

            const task = await TaskModel.findById(task_id, company_id);
            const permission = TaskAccessService.canComment(actor, task);
            if (!permission.allowed) {
                return { success: false, status: permission.status, message: permission.message };
            }

            const created = await TaskComment.create({
                task_id,
                company_id,
                employee_id: actor.employee_id,
                comment: String(comment).trim(),
            });

            return { success: true, message: "Remark added", data: created };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async getComments({ company_id, user, task_id, actor: cachedActor = null }) {
        try {
            const resolved = await TaskAccessService.ensureActor(user, company_id, cachedActor);
            if (!resolved.success) return { success: false, message: resolved.message };

            const task = await TaskModel.findById(task_id, company_id);
            const permission = TaskAccessService.canComment(resolved.actor, task);
            if (!permission.allowed) {
                return { success: false, status: permission.status, message: permission.message };
            }

            return { success: true, data: await TaskComment.findByTask(task_id) };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    /** Own remark, or an admin cleaning up. Soft delete — the thread keeps its shape. */
    async deleteComment({ company_id, user, task_id, comment_id, actor: cachedActor = null }) {
        try {
            const resolved = await TaskAccessService.ensureActor(user, company_id, cachedActor);
            if (!resolved.success) return { success: false, message: resolved.message };
            const { actor } = resolved;

            const existing = await TaskComment.findById(comment_id);
            if (!existing || existing.task_id !== task_id || existing.company_id !== company_id) {
                return { success: false, status: 404, message: "Remark not found." };
            }

            const isAuthor = existing.employee_id && existing.employee_id === actor.employee_id;
            if (!isAuthor && !actor.is_admin) {
                return { success: false, status: 403, message: "You can only delete your own remarks." };
            }

            return { success: true, message: "Remark deleted", data: await TaskComment.softDelete(comment_id) };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ─────────────────────────────────────────────────────────────────────
    // DELETE
    // ─────────────────────────────────────────────────────────────────────

    async deleteTask({ company_id, user, task_id, actor: cachedActor = null }) {
        try {
            const resolved = await TaskAccessService.ensureActor(user, company_id, cachedActor);
            if (!resolved.success) return { success: false, message: resolved.message };
            const { actor } = resolved;

            const task = await TaskModel.findById(task_id, company_id);
            const permission = TaskAccessService.canDelete(actor, task);
            if (!permission.allowed) {
                return { success: false, status: permission.status, message: permission.message };
            }

            // Soft delete. The history rows stay, and stay joined to a row
            // that still exists — the rollup filters deleted tasks out of new
            // days, but days already computed keep the numbers they reported.
            const deleted = await TaskModel.softDelete(task_id);

            return { success: true, message: "Task deleted successfully", data: deleted };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ─────────────────────────────────────────────────────────────────────
    // INTERNAL
    // ─────────────────────────────────────────────────────────────────────

    /** What this specific person may move this specific task to, right now. */
    _allowedTransitionsFor(actor, task) {
        const permission = TaskAccessService.canChangeStatus(actor, task);
        if (!permission.allowed) return [];

        const legal = ALLOWED_TRANSITIONS[task.status] || [];
        if (permission.as_manager) return legal;

        return legal.filter((s) => EMPLOYEE_ALLOWED_TARGETS.includes(s));
    },
};

module.exports = TaskService;
