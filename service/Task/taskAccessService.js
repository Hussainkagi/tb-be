const Employee = require("../../models/employeeModel");
const Department = require("../../models/departmentModel");
const { Role } = require("../../enums/roles");
const {
    TaskStatus,
    TaskStatusLabel,
    TaskRole,
    TaskRoleLabel,
    ALLOWED_TRANSITIONS,
    roleForTransition,
    isTerminal,
} = require("../../enums/Task/taskStatus");

/**
 * Who may do what to a task.
 *
 * The route layer can only ask "is this an admin?" — it cannot express "is
 * this employee the head of the department the assignee belongs to", because
 * being an HOD is not a role: it is departments.head_employee_id pointing at
 * you, and an HOD may carry any user_companies.role. So every task route is
 * mounted with `isEmployee` and the real decision is made here, against the
 * actual records.
 *
 * The rules, in one place:
 *
 *   ADMIN     any task in their company
 *   HOD       tasks whose department_id is a department they head, plus their
 *             own tasks like anyone else
 *   EMPLOYEE  tasks assigned to them, raised by them, or that they watch —
 *             read and comment. Never edit the terms of the task itself.
 *
 * Moving a task's status is a different question, answered per task rather
 * than per company role: see taskRolesOf below and TRANSITION_ROLES in
 * enums/Task/taskStatus.js.
 */

const ActorScope = Object.freeze({
    ADMIN:    "admin",
    HOD:      "hod",
    EMPLOYEE: "employee",
});

/**
 * Resolve the person behind the request into the record the rules are about.
 *
 * A user with no employee profile in this company is not an error at the auth
 * layer — an admin account may legitimately have none — but it IS an error
 * here for everything except read-all admin access, because a task is
 * assigned to an employee, not to a login.
 */
const resolveActor = async (user, company_id) => {
    if (!user) {
        return { success: false, status: 401, message: "Unauthorized." };
    }

    const role = parseInt(user.role, 10);
    const employee = await Employee.findByUserAndCompany(user.user_id, company_id);

    // One employee heads at most one department today (uq_department_head_employee),
    // but the scope is modelled as a list so adding multi-department heads
    // later touches this function only.
    let headedDepartmentIds = [];
    if (employee) {
        const headed = await Department.findByHeadEmployee(employee.id);
        if (headed && headed.company_id === company_id) {
            headedDepartmentIds = [headed.id];
        }
    }

    const isAdmin = role === Role.ADMIN || user.is_super_admin === true;
    const isHod = !isAdmin && headedDepartmentIds.length > 0;
    // employees.can_assign_tasks — an admin-granted override letting a
    // specific employee assign work to anyone in the company, independent of
    // role or department headship. Checked only in canAssignTo (assignment),
    // never in canEdit/canDelete/the status machine — the flag widens who a
    // person may hand work TO, not what they may do to a task afterward.
    const canAssignAny = !isAdmin && employee?.can_assign_tasks === true;

    return {
        success: true,
        actor: {
            user_id: user.user_id,
            company_id,
            role,
            employee_id: employee?.id ?? null,
            employee,
            department_id: employee?.department_id ?? null,
            headed_department_ids: headedDepartmentIds,
            is_admin: isAdmin,
            is_hod: isHod,
            can_assign_any: canAssignAny,
            scope: isAdmin ? ActorScope.ADMIN : isHod ? ActorScope.HOD : ActorScope.EMPLOYEE,
        },
    };
};

/**
 * resolveActor, unless the router already did it.
 *
 * loadTaskActor puts the answer on the request; the services take it as an
 * argument so they stay callable from a job or a script where there is no
 * request at all.
 */
const ensureActor = async (user, company_id, cached = null) => {
    if (cached && cached.company_id === company_id) {
        return { success: true, actor: cached };
    }
    return resolveActor(user, company_id);
};


/**
 * The list filter for this actor, handed to TaskModel.list as data.
 * An admin gets an empty object — no narrowing.
 */
const listScopeFor = (actor) => {
    if (actor.is_admin) return {};

    if (actor.is_hod) {
        return {
            department_ids: actor.headed_department_ids,
            self_employee_id: actor.employee_id,
        };
    }

    return { employee_id: actor.employee_id };
};

/**
 * May this actor assign work to this employee?
 *
 * Admin: anyone in the company. HOD: only their own department — and the
 * department is read off the EMPLOYEE record, never off the request body, so
 * a crafted department_id cannot widen the reach.
 */
const canAssignTo = (actor, targetEmployee) => {
    if (!targetEmployee) {
        return { allowed: false, status: 404, message: "Employee not found." };
    }
    if (targetEmployee.company_id !== actor.company_id) {
        return { allowed: false, status: 403, message: "Employee belongs to another company." };
    }
    if (targetEmployee.deleted_at || targetEmployee.is_active === false) {
        return { allowed: false, status: 400, message: "Cannot assign a task to an inactive employee." };
    }

    if (actor.is_admin || actor.can_assign_any) return { allowed: true };

    if (actor.is_hod) {
        if (!targetEmployee.department_id) {
            return {
                allowed: false,
                status: 403,
                message: "This employee is not in any department, so only an admin can assign them work.",
            };
        }
        if (!actor.headed_department_ids.includes(targetEmployee.department_id)) {
            return {
                allowed: false,
                status: 403,
                message: "You can only assign tasks to employees in the department you head.",
            };
        }
        return { allowed: true };
    }

    return {
        allowed: false,
        status: 403,
        message: "Only an admin or a head of department can assign tasks.",
    };
};

/** Can this actor open this task at all? */
const canView = (actor, task) => {
    if (!task) return { allowed: false, status: 404, message: "Task not found." };
    if (task.company_id !== actor.company_id) {
        return { allowed: false, status: 404, message: "Task not found." };
    }
    if (actor.is_admin) return { allowed: true };

    if (actor.is_hod && task.department_id && actor.headed_department_ids.includes(task.department_id)) {
        return { allowed: true };
    }

    if (
        actor.employee_id &&
        (task.assigned_to_employee_id === actor.employee_id ||
            task.assigned_by_employee_id === actor.employee_id ||
            (task.watcher_employee_ids || []).includes(actor.employee_id))
    ) {
        return { allowed: true };
    }

    // 404, not 403: telling someone a task exists but is none of their
    // business is itself a small leak of who is working on what.
    return { allowed: false, status: 404, message: "Task not found." };
};

/**
 * Can this actor edit the TERMS of the task — title, description, category,
 * criticality, deadline, assignee?
 *
 * Deliberately not the assignee, even for their own task. If the person doing
 * the work can move their own deadline, every on-time number the performance
 * dashboard reports is self-reported.
 */
const canEdit = (actor, task) => {
    const view = canView(actor, task);
    if (!view.allowed) return view;

    if (actor.is_admin) return { allowed: true };

    if (actor.is_hod && task.department_id && actor.headed_department_ids.includes(task.department_id)) {
        return { allowed: true };
    }

    // A can_assign_any employee is not an admin or HOD, but they DID just
    // assign this specific task — they must still be able to edit the terms
    // of their own assignment (e.g. attach a voice note right after
    // creating it). Narrower than "edit anything": only tasks they
    // personally assigned, never someone else's.
    if (actor.can_assign_any && task.assigned_by_employee_id === actor.employee_id) {
        return { allowed: true };
    }

    return {
        allowed: false,
        status: 403,
        message: "Only an admin or the head of this department can edit a task.",
    };
};

/** Deleting a task destroys its history — admin and HOD only, same as editing. */
const canDelete = (actor, task) => canEdit(actor, task);

/**
 * What this actor IS on this task — taskee, tasker, watcher, admin — as a
 * list, because one person can be several (an admin who assigned the task is
 * both its tasker and an admin). The workflow's buttons are granted per role,
 * and a person gets the union.
 *
 * The tasker is whoever assigned it; for an admin with no employee profile
 * that is recorded only as created_by_user_id. A tasker or taskee is never
 * also listed as a watcher, even though the tasker sits in task_watchers to
 * receive notifications.
 *
 * Expects the task as TaskModel.findById returns it (with watcher_employee_ids).
 */
const taskRolesOf = (actor, task) => {
    if (!task) return [];
    const roles = [];

    const isTaskee = Boolean(actor.employee_id) && task.assigned_to_employee_id === actor.employee_id;
    const isTasker = task.assigned_by_employee_id
        ? Boolean(actor.employee_id) && task.assigned_by_employee_id === actor.employee_id
        : Boolean(task.created_by_user_id) && task.created_by_user_id === actor.user_id;

    if (isTaskee) roles.push(TaskRole.TASKEE);
    if (isTasker) roles.push(TaskRole.TASKER);
    if (
        !isTaskee && !isTasker &&
        actor.employee_id &&
        (task.watcher_employee_ids || []).includes(actor.employee_id)
    ) {
        roles.push(TaskRole.WATCHER);
    }
    if (actor.is_admin) roles.push(TaskRole.ADMIN);

    return roles;
};

/**
 * The role a message's author holds on the task, for the chat's labels.
 * Same precedence as taskRolesOf; an admin with no employee profile is
 * recognised by user id.
 */
const authorRoleOn = (task, { employee_id = null, user_id = null } = {}) => {
    if (!task) return null;
    if (employee_id && task.assigned_to_employee_id === employee_id) return TaskRole.TASKEE;
    if (employee_id && task.assigned_by_employee_id === employee_id) return TaskRole.TASKER;
    if (!task.assigned_by_employee_id && user_id && task.created_by_user_id === user_id) return TaskRole.TASKER;
    if (employee_id && (task.watcher_employee_ids || []).includes(employee_id)) return TaskRole.WATCHER;
    return TaskRole.ADMIN;
};

/** The statuses this actor may move this task to right now. Empty = no buttons. */
const allowedTransitionsFor = (actor, task) => {
    if (!canView(actor, task).allowed) return [];
    const roles = taskRolesOf(actor, task);
    return (ALLOWED_TRANSITIONS[task.status] || []).filter((to) => roleForTransition(task.status, to, roles));
};

/**
 * May this actor move this task to `to`? On success, `role` is the task role
 * the move is made in — it goes into the history next to their name.
 *
 * Assumes the transition itself is legal (canTransition); this answers only
 * "is it legal for THIS person".
 */
const canTransitionTo = (actor, task, to) => {
    const view = canView(actor, task);
    if (!view.allowed) return view;

    const role = roleForTransition(task.status, to, taskRolesOf(actor, task));
    if (role) return { allowed: true, role };

    // Say who CAN, in the spec's words, so the refusal explains the workflow.
    const messages = {
        [TaskStatus.IN_PROGRESS]: "Only the person this task is assigned to can start or pick it back up.",
        [TaskStatus.OPEN]: "Only the person this task is assigned to can move it back to To Do.",
        [TaskStatus.SUBMITTED]: "Only the person this task is assigned to can submit it for review.",
        [TaskStatus.COMPLETED]: "Only the tasker who assigned this task, or a watcher on it, can approve and complete it.",
        [TaskStatus.REOPENED]: "Only the tasker who assigned this task can send it back.",
        [TaskStatus.CANCELLED]: "Only the tasker who assigned this task, or an admin, can cancel it.",
    };
    return {
        allowed: false,
        status: 403,
        message: messages[to] || `You cannot move this task to ${TaskStatusLabel[to] || to}.`,
    };
};

/** A cancelled task is read-only: remarks, voice notes and buttons all lock. */
const LOCKED_MESSAGE = "This task has been cancelled and is now read-only.";

/**
 * The conversation (messages, photos, voice notes) closes once the task is
 * finished either way — Completed or Cancelled. Past messages stay readable.
 */
const isChatLocked = (task) => isTerminal(task.status);

const chatLockedMessage = (task) =>
    task.status === TaskStatus.COMPLETED
        ? "This task is completed — its conversation is closed."
        : LOCKED_MESSAGE;

/**
 * Anyone who can see the task can leave a remark on it — while it is live
 * (not Completed, not Cancelled).
 * Past remarks stay readable (getComments only needs canView).
 */
const canComment = (actor, task) => {
    const view = canView(actor, task);
    if (!view.allowed) return view;
    if (isChatLocked(task)) {
        return { allowed: false, status: 409, message: chatLockedMessage(task) };
    }
    return { allowed: true };
};

/**
 * Voice notes are a Tasker ⇄ Taskee conversation: only those two record.
 * Everyone who can see the task can listen.
 */
const canRecordVoiceNote = (actor, task) => {
    const view = canView(actor, task);
    if (!view.allowed) return view;
    if (isChatLocked(task)) {
        return { allowed: false, status: 409, message: chatLockedMessage(task) };
    }

    const roles = taskRolesOf(actor, task);
    const role = [TaskRole.TASKER, TaskRole.TASKEE].find((r) => roles.includes(r));
    if (!role) {
        return {
            allowed: false,
            status: 403,
            message: "Only the tasker and the taskee can record voice notes on this task.",
        };
    }
    return { allowed: true, role };
};

/** "Tasker", "Admin"… — the capacity a person acted in, for messages and history. */
const taskRoleLabel = (role) => TaskRoleLabel[role] || role || "";

/** What the acting capacity is called in task_status_history.changed_by_role. */
const actingRoleOf = (actor) => (actor.is_admin ? String(Role.ADMIN) : actor.is_hod ? "hod" : String(actor.role));

module.exports = {
    ActorScope,
    resolveActor,
    ensureActor,
    listScopeFor,
    canAssignTo,
    canView,
    canEdit,
    canDelete,
    taskRolesOf,
    authorRoleOn,
    allowedTransitionsFor,
    canTransitionTo,
    canComment,
    canRecordVoiceNote,
    isChatLocked,
    chatLockedMessage,
    taskRoleLabel,
    actingRoleOf,
};
