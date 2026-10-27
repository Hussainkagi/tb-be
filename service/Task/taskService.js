const db = require("../../config/database");

const { TaskModel } = require("../../models/Task/taskModel");
const { TaskCategoryModel } = require("../../models/Task/taskCategoryModel");
const {
    TaskStatusHistory,
    TaskComment,
    TaskWatcher,
    TaskVoiceNote,
} = require("../../models/Task/taskActivityModel");

const Employee = require("../../models/employeeModel");
const Department = require("../../models/departmentModel");

const TaskAccessService = require("./taskAccessService");
const TaskNotificationService = require("./taskNotificationService");
const EntitlementService = require("../entitlementService");
const { Feature } = require("../../enums/features");
const { uploadToCloudinary, deleteFromCloudinary, privateDownloadUrl } = require("../../utils/cloudinaryHelper");

const {
    TaskStatus,
    TaskStatusLabel,
    TaskRole,
    canTransition,
    isValidStatus,
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
 * Everyone who should hear about a change to this task: the taskee, the
 * tasker and the registered watchers (the HOD is added at creation). The
 * person who acted is removed by the notification service, and an admin is
 * only on this list if they are on the task.
 */
const audienceFor = async (task) => {
    const watchers = await TaskWatcher.findEmployeeIds(task.id);
    return [
        ...new Set(
            [task.assigned_to_employee_id, task.assigned_by_employee_id, ...watchers].filter(Boolean)
        ),
    ];
};

/**
 * The actor's display name — their employee name, or the login's own name
 * for an admin who has no employee profile.
 */
const actorName = async (actor) => {
    const name = fullName(actor.employee);
    if (name) return name;
    const result = await db.query(`SELECT first_name, last_name FROM users WHERE id = $1`, [actor.user_id]);
    const row = result.rows[0];
    return row ? `${row.first_name} ${row.last_name}`.trim() : null;
};

/**
 * Chat annotations for remarks and voice notes: which side of the thread a
 * message sits on for THIS viewer, and the sender's role on the task.
 */
const annotateComment = (task, actor) => (c) => ({
    ...c,
    sender_task_role: TaskAccessService.authorRoleOn(task, { employee_id: c.employee_id, user_id: c.author_user_id }),
    is_mine: c.employee_id
        ? c.employee_id === actor.employee_id
        : Boolean(c.author_user_id) && c.author_user_id === actor.user_id,
});

/**
 * A shared document's display name, size and type. multer reads the
 * multipart filename as latin1, so a name in Arabic or Urdu arrives garbled
 * unless it is re-read as UTF-8. `safeName` is what Cloudinary stores it as.
 */
function chatDocumentMeta(file) {
    const name = Buffer.from(file.originalname || "file", "latin1").toString("utf8").slice(0, 255);
    const dot = name.lastIndexOf(".");
    const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
    const stem = (dot > 0 ? name.slice(0, dot) : name)
        .replace(/[^\w.-]+/g, "_")
        .slice(0, 80) || "file";
    return {
        name,
        size: file.size ?? file.buffer?.length ?? null,
        mime: file.mimetype || null,
        safeName: extension ? `${stem}.${extension}` : stem,
    };
}

const annotateVoiceNote = (actor) => (v) => ({
    ...v,
    is_mine: v.sender_employee_id
        ? v.sender_employee_id === actor.employee_id
        : Boolean(v.sender_user_id) && v.sender_user_id === actor.user_id,
});

/** The spec's hard ceiling on a task's voice note chain, whatever the plan says. */
const VOICE_NOTE_CHAIN_MAX = 15;

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

            if (!actor.is_admin && !actor.is_hod && !actor.can_assign_any) {
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
                    changed_by_user_id: actor.user_id,
                    changed_by_task_role: TaskRole.TASKER,
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
            const assignedByName = await actorName(actor);
            TaskNotificationService.notifyAssigned({
                task: created,
                assigned_by_name: assignedByName,
            }).catch((err) =>
                console.error("[Notification] task_assigned failed:", err.message)
            );

            // Watchers hear about it too; the tasker does not — they did it.
            TaskWatcher.findEmployeeIds(created.id)
                .then((watcherIds) =>
                    TaskNotificationService.notifyWatchersAssigned({
                        task: created,
                        assigned_by_name: assignedByName,
                        actor_employee_id: actor.employee_id,
                        watcher_employee_ids: watcherIds,
                    })
                )
                .catch((err) =>
                    console.error("[Notification] task_assigned_watcher failed:", err.message)
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

            const [history, comments, watchers, voiceNotes, voiceNoteLimit] = await Promise.all([
                TaskStatusHistory.findByTask(task_id),
                TaskComment.findByTask(task_id),
                TaskWatcher.findEmployeeIds(task_id),
                TaskVoiceNote.findByTask(task_id),
                TaskService._voiceNoteChainLimit(company_id),
            ]);

            const isLocked = task.status === TaskStatus.CANCELLED;

            // Shown at the top of a cancelled task: the most recent move to
            // cancelled, with who did it and in what capacity.
            const cancelRow = isLocked
                ? [...history].reverse().find((h) => h.to_status === TaskStatus.CANCELLED)
                : null;

            const recordPermission = TaskAccessService.canRecordVoiceNote(actor, task);

            return {
                success: true,
                data: {
                    ...task,
                    status_label: TaskStatusLabel[task.status],
                    // What this caller is on this task — drives which buttons
                    // exist, and is shown next to their name.
                    my_roles: TaskAccessService.taskRolesOf(actor, task),
                    // The frontend renders the action buttons from this, so a
                    // rule change here never needs a matching client release.
                    allowed_transitions: TaskAccessService.allowedTransitionsFor(actor, task),
                    can_edit: !isLocked && TaskAccessService.canEdit(actor, task).allowed,
                    can_comment: TaskAccessService.canComment(actor, task).allowed,
                    // Completed or Cancelled: the conversation is read-only.
                    chat_locked: TaskAccessService.isChatLocked(task),
                    is_locked: isLocked,
                    cancellation: cancelRow
                        ? {
                            reason: cancelRow.remark,
                            cancelled_by_name: cancelRow.changed_by_name,
                            cancelled_by_role: cancelRow.changed_by_task_role,
                            cancelled_at: cancelRow.created_at,
                        }
                        : null,
                    history,
                    comments: comments.map(annotateComment(task, actor)),
                    watcher_employee_ids: watchers,
                    voice_notes: voiceNotes.map(annotateVoiceNote(actor)),
                    voice_note_count: voiceNotes.length,
                    voice_note_limit: voiceNoteLimit,
                    // True only for the tasker or taskee, on a live task, under the cap.
                    can_record_voice_note: recordPermission.allowed && voiceNotes.length < voiceNoteLimit,
                    voice_note_max_seconds: await TaskService._voiceNoteMaxSeconds(company_id),
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
                meta: { scope: actor.scope, can_assign_any: actor.can_assign_any },
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
                    can_assign_any: actor.can_assign_any,
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
                return { success: false, status: 409, message: "This task has been cancelled and is now read-only." };
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

            // ── Reassignment — allowed exactly once per task ────────────────
            let reassignedTo = null;
            const previousAssigneeId = task.assigned_to_employee_id;
            if (data.assigned_to_employee_id && data.assigned_to_employee_id !== task.assigned_to_employee_id) {
                if (task.reassigned_at) {
                    return {
                        success: false,
                        status: 409,
                        message:
                            "This task has already been reassigned once. Create a new task for the new assignee and close this one instead.",
                    };
                }
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
            if (reassignedTo) await TaskModel.markReassigned(task_id);
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

                // The person who no longer has this task needs to hear it from
                // us, not discover it when it silently vanishes from their board.
                if (previousAssigneeId) {
                    TaskNotificationService.notifyUnassigned({
                        task: updated,
                        previous_assignee_employee_id: previousAssigneeId,
                        reassigned_by_name: fullName(actor.employee),
                    }).catch((err) =>
                        console.error("[Notification] task_unassigned failed:", err.message)
                    );
                }
            }

            return { success: true, message: "Task updated successfully", data: updated };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    /**
     * Attach (or replace) a task's voice note.
     *
     * The plan's max length is read live from entitlements and checked
     * against Cloudinary's OWN reported duration, not whatever the client
     * claims — a client can lie about a recording's length, Cloudinary's
     * media probe cannot. A recording that comes back over the cap is
     * deleted from Cloudinary immediately rather than left orphaned.
     */
    async attachVoiceNote({ company_id, user, task_id, audioBuffer, actor: cachedActor = null }) {
        try {
            if (!audioBuffer) {
                return { success: false, message: "voice_note file is required" };
            }

            const resolved = await TaskAccessService.ensureActor(user, company_id, cachedActor);
            if (!resolved.success) return { success: false, message: resolved.message };
            const { actor } = resolved;

            const task = await TaskModel.findById(task_id, company_id);
            const permission = TaskAccessService.canEdit(actor, task);
            if (!permission.allowed) {
                return { success: false, status: permission.status, message: permission.message };
            }
            if (task.status === TaskStatus.CANCELLED) {
                return { success: false, status: 409, message: "This task has been cancelled and is now read-only." };
            }

            const clip = await TaskService._uploadVoiceClip(company_id, task_id, audioBuffer);
            if (!clip.success) return clip;
            const { upload, duration } = clip;

            // A replacement — delete whatever was there before, only after the
            // new upload has already succeeded and passed the duration check,
            // so a failed re-record never leaves the task with no voice note.
            if (task.voice_note_public_id) {
                await deleteFromCloudinary(task.voice_note_public_id, "video").catch((err) =>
                    console.error("[Tasks] Failed to delete replaced voice note:", err.message)
                );
            }

            const updated = await TaskModel.setVoiceNote(task_id, {
                url: upload.secureUrl,
                public_id: upload.publicId,
                duration_seconds: duration,
                format: upload.format,
            });

            return { success: true, message: "Voice note attached", data: updated };
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
     * Three gates, in order: may this actor see the task at all, is the
     * transition legal for anybody, and is it legal for THIS actor in the
     * role(s) they hold on this task — see TRANSITION_ROLES in
     * enums/Task/taskStatus.js. A cancel additionally needs a written reason,
     * which is stored as the history row's remark.
     */
    async changeStatus({ company_id, user, task_id, status, remark = null, actor: cachedActor = null }) {
        try {
            const resolved = await TaskAccessService.ensureActor(user, company_id, cachedActor);
            if (!resolved.success) return { success: false, message: resolved.message };
            const { actor } = resolved;

            const task = await TaskModel.findById(task_id, company_id);
            const view = TaskAccessService.canView(actor, task);
            if (!view.allowed) {
                return { success: false, status: view.status, message: view.message };
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
            if (task.status === TaskStatus.CANCELLED) {
                return { success: false, status: 409, message: "This task has been cancelled and is now read-only." };
            }
            if (!canTransition(task.status, status)) {
                return {
                    success: false,
                    message: `A ${TaskStatusLabel[task.status]} task cannot move to ${TaskStatusLabel[status]}.`,
                };
            }

            const permission = TaskAccessService.canTransitionTo(actor, task, status);
            if (!permission.allowed) {
                return { success: false, status: permission.status, message: permission.message };
            }

            remark = remark === null || remark === undefined ? null : String(remark).trim() || null;
            if (status === TaskStatus.CANCELLED && !remark) {
                return { success: false, message: "A reason is required to cancel a task." };
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
                    changed_by_user_id: actor.user_id,
                    changed_by_task_role: permission.role,
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
            const name = await actorName(actor);
            const notification = status === TaskStatus.CANCELLED
                ? TaskNotificationService.notifyCancelled({
                    task: fresh,
                    actor_name: name,
                    actor_role_label: TaskAccessService.taskRoleLabel(permission.role),
                    actor_employee_id: actor.employee_id,
                    reason: remark,
                    recipient_employee_ids: recipients,
                })
                : TaskNotificationService.notifyStatusChange({
                    task: fresh,
                    previous_status,
                    actor_name: name,
                    actor_employee_id: actor.employee_id,
                    remark,
                    recipient_employee_ids: recipients,
                });
            notification.catch((err) =>
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

    /**
     * A message in the task's conversation: text and/or one attachment — a
     * photo or a document (PDF, Word, Excel; the route checks the type).
     * Anyone who can see a live task may post (the spec's Remarks rule).
     */
    async addComment({ company_id, user, task_id, comment, imageBuffer = null, document = null, actor: cachedActor = null }) {
        try {
            const resolved = await TaskAccessService.ensureActor(user, company_id, cachedActor);
            if (!resolved.success) return { success: false, message: resolved.message };
            const { actor } = resolved;

            const text = comment === null || comment === undefined ? "" : String(comment).trim();
            if (!text && !imageBuffer && !document) {
                return { success: false, message: "A message, a photo or a file is required." };
            }
            if (imageBuffer && document) {
                return { success: false, message: "Send one attachment per message." };
            }

            const task = await TaskModel.findById(task_id, company_id);
            const permission = TaskAccessService.canComment(actor, task);
            if (!permission.allowed) {
                return { success: false, status: permission.status, message: permission.message };
            }

            let upload = null;
            let file = null;
            if (imageBuffer) {
                upload = await uploadToCloudinary(imageBuffer, {
                    folder: `tasks/chat/${task_id}`,
                    resourceType: "image",
                });
            } else if (document) {
                file = chatDocumentMeta(document);
                // "raw" keeps the file byte-for-byte; the extension has to be
                // part of a raw public_id or the URL loses it.
                upload = await uploadToCloudinary(document.buffer, {
                    folder: `tasks/chat/${task_id}`,
                    resourceType: "raw",
                    publicId: `${Date.now()}_${file.safeName}`,
                });
            }

            const created = await TaskComment.create({
                task_id,
                company_id,
                employee_id: actor.employee_id,
                author_user_id: actor.user_id,
                comment: text || null,
                attachment_url: upload?.secureUrl ?? null,
                attachment_public_id: upload?.publicId ?? null,
                attachment_type: imageBuffer ? "image" : document ? "document" : null,
                attachment_name: file?.name ?? null,
                attachment_size: file?.size ?? null,
                attachment_mime: file?.mime ?? null,
            });

            audienceFor(task)
                .then(async (recipients) =>
                    TaskNotificationService.notifyRemark({
                        task,
                        actor_name: await actorName(actor),
                        actor_employee_id: actor.employee_id,
                        comment:
                            created.comment ||
                            (document ? `📎 Sent a file: ${file.name}` : "📷 Sent a photo"),
                        recipient_employee_ids: recipients,
                    })
                )
                .catch((err) => console.error("[Notification] task_remark_added failed:", err.message));

            return {
                success: true,
                message: "Remark added",
                data: annotateComment(task, actor)({ ...created, employee_name: await actorName(actor) }),
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async getComments({ company_id, user, task_id, actor: cachedActor = null }) {
        try {
            const resolved = await TaskAccessService.ensureActor(user, company_id, cachedActor);
            if (!resolved.success) return { success: false, message: resolved.message };

            const task = await TaskModel.findById(task_id, company_id);
            // Readable on a cancelled task too — only adding is locked.
            const permission = TaskAccessService.canView(resolved.actor, task);
            if (!permission.allowed) {
                return { success: false, status: permission.status, message: permission.message };
            }

            const comments = await TaskComment.findByTask(task_id);
            return { success: true, data: comments.map(annotateComment(task, resolved.actor)) };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    /**
     * Where to fetch a chat attachment from, for anyone who can see the task.
     * The controller streams it to the client as a download; the stored URL
     * itself can't be used for documents (Cloudinary refuses public PDFs).
     */
    async getCommentFile({ company_id, user, task_id, comment_id, actor: cachedActor = null }) {
        try {
            const resolved = await TaskAccessService.ensureActor(user, company_id, cachedActor);
            if (!resolved.success) return { success: false, message: resolved.message };

            const task = await TaskModel.findById(task_id, company_id);
            const permission = TaskAccessService.canView(resolved.actor, task);
            if (!permission.allowed) {
                return { success: false, status: permission.status, message: permission.message };
            }

            // findById skips deleted rows, so a deleted message's file is gone too.
            const existing = await TaskComment.findById(comment_id);
            if (
                !existing ||
                existing.task_id !== task_id ||
                existing.company_id !== company_id ||
                !existing.attachment_public_id
            ) {
                return { success: false, status: 404, message: "File not found." };
            }

            const isDocument = existing.attachment_type === "document";
            return {
                success: true,
                data: {
                    url: privateDownloadUrl(existing.attachment_public_id, {
                        resourceType: isDocument ? "raw" : "image",
                        format: isDocument ? "" : "jpg",
                    }),
                    name: existing.attachment_name || (isDocument ? "document" : "photo.jpg"),
                    mime: existing.attachment_mime || (isDocument ? "application/octet-stream" : "image/jpeg"),
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    /**
     * Own remark, or an admin cleaning up. Soft delete that records who did
     * it: the thread shows a "Message deleted by …" placeholder in its place.
     */
    async deleteComment({ company_id, user, task_id, comment_id, actor: cachedActor = null }) {
        try {
            const resolved = await TaskAccessService.ensureActor(user, company_id, cachedActor);
            if (!resolved.success) return { success: false, message: resolved.message };
            const { actor } = resolved;

            const existing = await TaskComment.findById(comment_id);
            if (!existing || existing.task_id !== task_id || existing.company_id !== company_id) {
                return { success: false, status: 404, message: "Remark not found." };
            }

            // A finished task's conversation is closed — messages stay as they were.
            const task = await TaskModel.findById(task_id, company_id);
            if (task && TaskAccessService.isChatLocked(task)) {
                return { success: false, status: 409, message: TaskAccessService.chatLockedMessage(task) };
            }

            const isAuthor = existing.employee_id
                ? existing.employee_id === actor.employee_id
                : Boolean(existing.author_user_id) && existing.author_user_id === actor.user_id;
            if (!isAuthor && !actor.is_admin) {
                return { success: false, status: 403, message: "You can only delete your own remarks." };
            }

            return { success: true, message: "Remark deleted", data: await TaskComment.softDelete(comment_id, actor.user_id) };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ─────────────────────────────────────────────────────────────────────
    // VOICE NOTE CHAIN — Tasker ⇄ Taskee
    // ─────────────────────────────────────────────────────────────────────

    /** Everyone who can see the task can listen. */
    async getVoiceNotes({ company_id, user, task_id, actor: cachedActor = null }) {
        try {
            const resolved = await TaskAccessService.ensureActor(user, company_id, cachedActor);
            if (!resolved.success) return { success: false, message: resolved.message };
            const { actor } = resolved;

            const task = await TaskModel.findById(task_id, company_id);
            const permission = TaskAccessService.canView(actor, task);
            if (!permission.allowed) {
                return { success: false, status: permission.status, message: permission.message };
            }

            const [notes, limit] = await Promise.all([
                TaskVoiceNote.findByTask(task_id),
                TaskService._voiceNoteChainLimit(company_id),
            ]);

            return {
                success: true,
                data: notes,
                meta: {
                    count: notes.length,
                    limit,
                    can_record:
                        TaskAccessService.canRecordVoiceNote(actor, task).allowed && notes.length < limit,
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    /**
     * Add one note to the chain. Only the tasker and the taskee record; the
     * cap counts both of them together. The count is re-checked after the
     * upload — two people recording at once must not both squeeze past it.
     */
    async addVoiceNote({ company_id, user, task_id, audioBuffer, actor: cachedActor = null }) {
        try {
            if (!audioBuffer) {
                return { success: false, message: "voice_note file is required" };
            }

            const resolved = await TaskAccessService.ensureActor(user, company_id, cachedActor);
            if (!resolved.success) return { success: false, message: resolved.message };
            const { actor } = resolved;

            const task = await TaskModel.findById(task_id, company_id);
            const permission = TaskAccessService.canRecordVoiceNote(actor, task);
            if (!permission.allowed) {
                return { success: false, status: permission.status, message: permission.message };
            }

            const limit = await TaskService._voiceNoteChainLimit(company_id);
            const limitReached = { success: false, status: 409, message: "Voice note limit reached for this task." };
            if ((await TaskVoiceNote.countByTask(task_id)) >= limit) return limitReached;

            const clip = await TaskService._uploadVoiceClip(company_id, task_id, audioBuffer);
            if (!clip.success) return clip;
            const { upload, duration } = clip;

            const client = await db.getClient();
            let created;
            try {
                await client.query("BEGIN");
                // Serialise concurrent recordings on the same task.
                await client.query(`SELECT id FROM tasks WHERE id = $1 FOR UPDATE`, [task_id]);
                if ((await TaskVoiceNote.countByTask(task_id, client)) >= limit) {
                    await client.query("ROLLBACK");
                    await deleteFromCloudinary(upload.publicId, "video").catch(() => {});
                    return limitReached;
                }
                created = await TaskVoiceNote.create({
                    task_id,
                    company_id,
                    sender_employee_id: actor.employee_id,
                    sender_user_id: actor.user_id,
                    sender_task_role: permission.role,
                    url: upload.secureUrl,
                    public_id: upload.publicId,
                    duration_seconds: duration,
                    format: upload.format,
                }, client);
                await client.query("COMMIT");
            } catch (error) {
                await client.query("ROLLBACK");
                throw error;
            } finally {
                client.release();
            }

            const name = await actorName(actor);
            audienceFor(task)
                .then((recipients) =>
                    TaskNotificationService.notifyVoiceNote({
                        task,
                        actor_name: name,
                        actor_employee_id: actor.employee_id,
                        duration_seconds: duration,
                        recipient_employee_ids: recipients,
                    })
                )
                .catch((err) => console.error("[Notification] task_voice_note_added failed:", err.message));

            const count = await TaskVoiceNote.countByTask(task_id);
            return {
                success: true,
                message: "Voice note sent",
                data: annotateVoiceNote(actor)({ ...created, sender_name: name }),
                meta: { count, limit, can_record: count < limit },
            };
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

    /**
     * The task's voice note cap: the plan's number, never above 15. An
     * unconfigured or unlimited plan value means the spec's maximum.
     */
    async _voiceNoteChainLimit(company_id) {
        const snapshot = await EntitlementService.getSnapshot(company_id);
        const value = snapshot?.features?.[Feature.TASK_VOICE_NOTE_CHAIN_LIMIT];
        if (value === null || value === undefined) return VOICE_NOTE_CHAIN_MAX;
        return Math.max(0, Math.min(Number(value) || 0, VOICE_NOTE_CHAIN_MAX));
    },

    /** Max length of ONE recording on this plan, in seconds. null = no cap. */
    async _voiceNoteMaxSeconds(company_id) {
        const snapshot = await EntitlementService.getSnapshot(company_id);
        const value = snapshot?.features?.[Feature.TASK_VOICE_NOTE_MAX_SECONDS];
        return value === undefined ? 0 : value;
    },

    /**
     * Upload one recording and check its length against the plan.
     *
     * The length is Cloudinary's OWN reported duration, not whatever the
     * client claims — a client can lie about a recording's length, the media
     * probe cannot. A recording over the cap is deleted immediately rather
     * than left orphaned.
     */
    async _uploadVoiceClip(company_id, task_id, audioBuffer) {
        const maxSeconds = await TaskService._voiceNoteMaxSeconds(company_id);

        const upload = await uploadToCloudinary(audioBuffer, {
            folder: `tasks/voice-notes/${task_id}`,
            resourceType: "video", // Cloudinary's umbrella type for audio too
        });

        const duration = Math.ceil(upload.duration ?? 0);
        if (maxSeconds !== null && duration > maxSeconds) {
            await deleteFromCloudinary(upload.publicId, "video").catch((err) =>
                console.error("[Tasks] Failed to clean up over-limit voice note:", err.message)
            );
            return {
                success: false,
                status: 403,
                message: `Voice notes on your plan are limited to ${maxSeconds} seconds — this recording is ${duration}s.`,
            };
        }

        return { success: true, upload, duration };
    },

};

module.exports = TaskService;
