const Employee = require("../../models/employeeModel");
const Department = require("../../models/departmentModel");
const { Role } = require("../../enums/roles");

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
 *   EMPLOYEE  tasks assigned to them or raised by them — read, move status,
 *             comment. Never edit the terms of the task itself.
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

    if (actor.is_admin) return { allowed: true };

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
            task.assigned_by_employee_id === actor.employee_id)
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

    return {
        allowed: false,
        status: 403,
        message: "Only an admin or the head of this department can edit a task.",
    };
};

/** Deleting a task destroys its history — admin and HOD only, same as editing. */
const canDelete = (actor, task) => canEdit(actor, task);

/**
 * Can this actor move the task's status?
 *
 * Broader than canEdit: the assignee is the whole point of the module. WHICH
 * statuses they may move it to is a separate question, answered by
 * EMPLOYEE_ALLOWED_TARGETS in enums/Task/taskStatus.js.
 */
const canChangeStatus = (actor, task) => {
    const view = canView(actor, task);
    if (!view.allowed) return view;

    if (actor.is_admin) return { allowed: true, as_manager: true };

    if (actor.is_hod && task.department_id && actor.headed_department_ids.includes(task.department_id)) {
        return { allowed: true, as_manager: true };
    }

    if (task.assigned_to_employee_id === actor.employee_id) {
        return { allowed: true, as_manager: false };
    }

    return {
        allowed: false,
        status: 403,
        message: "Only the assignee, their head of department or an admin can update this task.",
    };
};

/** Anyone who can see the task can leave a remark on it. */
const canComment = (actor, task) => canView(actor, task);

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
    canChangeStatus,
    canComment,
    actingRoleOf,
};
