const DepartmentModel = require("../models/departmentModel");
const CompanyModel = require("../models/companyModel");
const BranchModel = require("../models/branchModel");
const EmployeeModel = require("../models/employeeModel");
const LeaveRequestModel = require("../models/leaveRequestModel");

const DepartmentService = {
    async createDepartment(data) {
        try {
            const { company_id, branch_id, department_name } = data;

            // 1. Verify company exists and is active
            const company = await CompanyModel.findById(company_id);
            if (!company || !company.is_active) {
                return { success: false, message: "Company not found or inactive" };
            }

            // 2. Verify branch exists and belongs to the company
            const branch = await BranchModel.findById(branch_id);
            if (!branch || branch.company_id !== company_id) {
                return { success: false, message: "Branch not found or does not belong to this company" };
            }

            // 3. Check department_name unique within branch
            const existing = await DepartmentModel.findByName(company_id, branch_id, department_name);
            if (existing) {
                return { success: false, message: "Department name already exists in this branch" };
            }

            const result = await DepartmentModel.create(data);
            return {
                success: true,
                message: "Department created successfully",
                data: result,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async getDepartmentById(id) {
        try {
            const result = await DepartmentModel.findById(id);
            if (!result) {
                return { success: false, message: "Department not found" };
            }
            return { success: true, data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async getDepartmentsByCompany(company_id) {
        try {
            const result = await DepartmentModel.findAllByCompany(company_id);
            return { success: true, data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async getDepartmentsByBranch(company_id, branch_id) {
        try {
            const result = await DepartmentModel.findAllByBranch(company_id, branch_id);
            return { success: true, data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async updateDepartment(id, data) {
        try {
            // Prevent company_id and branch_id from being changed
            delete data.company_id;
            delete data.branch_id;
            // Head is managed through setDepartmentHead — it needs validation
            // that a generic column update cannot do.
            delete data.head_employee_id;

            // If department_name is being updated, check uniqueness
            if (data.department_name) {
                const department = await DepartmentModel.findById(id);
                if (!department) {
                    return { success: false, message: "Department not found" };
                }
                const existing = await DepartmentModel.findByName(
                    department.company_id,
                    department.branch_id,
                    data.department_name
                );
                if (existing && existing.id !== id) {
                    return { success: false, message: "Department name already exists in this branch" };
                }
            }

            const result = await DepartmentModel.update(id, data);
            if (!result) {
                return { success: false, message: "Department not found" };
            }
            return {
                success: true,
                message: "Department updated successfully",
                data: result,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async deactivateDepartment(id) {
        try {
            const result = await DepartmentModel.deactivate(id);
            if (!result) {
                return { success: false, message: "Department not found" };
            }
            return {
                success: true,
                message: "Department deactivated successfully",
                data: result,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ── HEAD OF DEPARTMENT ────────────────────────────────────────────────
    //
    // Rules:
    //  • a department has at most one head
    //  • the head must be an employee of that same department
    //  • an employee can head only one department
    //  • a department with employees must have a head — so the head can only
    //    be removed when replaced, or when the department has no employees
    //
    async setDepartmentHead(department_id, employee_id, { replace = false } = {}) {
        try {
            const department = await DepartmentModel.findById(department_id);
            if (!department) {
                return { success: false, message: "Department not found" };
            }

            const employee = await EmployeeModel.findById(employee_id);
            if (!employee) {
                return { success: false, message: "Employee not found" };
            }

            if (employee.company_id !== department.company_id) {
                return { success: false, message: "Employee does not belong to this company" };
            }

            if (employee.department_id !== department_id) {
                return {
                    success: false,
                    message: "Employee must belong to this department to be its head",
                };
            }

            if (employee.status !== "active" || employee.is_active === false) {
                return { success: false, message: "Only an active employee can be head of department" };
            }

            // Already the head — nothing to do
            if (department.head_employee_id === employee_id) {
                return {
                    success: true,
                    message: "Employee is already head of this department",
                    data: department,
                };
            }

            // An employee cannot head two departments at once
            const otherDepartment = await DepartmentModel.findByHeadEmployee(employee_id);
            if (otherDepartment && otherDepartment.id !== department_id) {
                return {
                    success: false,
                    message: `Employee is already head of "${otherDepartment.department_name}". Remove them from that department first.`,
                };
            }

            // Replacing an existing head must be explicit — protects against
            // an accidental overwrite from the create-employee flow.
            if (department.head_employee_id && !replace) {
                return {
                    success: false,
                    message: "This department already has a head. Pass replace: true to change it.",
                    data: {
                        current_head_employee_id: department.head_employee_id,
                        current_head_name: `${department.head_first_name ?? ""} ${department.head_last_name ?? ""}`.trim(),
                    },
                };
            }

            await DepartmentModel.setHead(department_id, employee_id);

            // Leave requests still waiting on the previous head now belong to
            // the new one — otherwise they would stall forever.
            const reassigned = await LeaveRequestModel.reassignHodForDepartment(
                department_id,
                employee_id
            );

            const updated = await DepartmentModel.findById(department_id);

            return {
                success: true,
                message: "Head of department assigned successfully",
                data: updated,
                reassigned_leave_requests: reassigned.length,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async removeDepartmentHead(department_id) {
        try {
            const department = await DepartmentModel.findById(department_id);
            if (!department) {
                return { success: false, message: "Department not found" };
            }

            if (!department.head_employee_id) {
                return { success: false, message: "This department has no head" };
            }

            // A department with employees must keep a head — the caller should
            // assign a replacement instead of clearing it.
            const employeeCount = await DepartmentModel.countEmployees(department_id);
            if (employeeCount > 0) {
                return {
                    success: false,
                    message: `This department has ${employeeCount} employee(s), so it must have a head. Assign a new head instead of removing the current one.`,
                };
            }

            await DepartmentModel.clearHead(department_id);
            await LeaveRequestModel.releaseHodStageForDepartment(department_id);
            const updated = await DepartmentModel.findById(department_id);

            return {
                success: true,
                message: "Head of department removed successfully",
                data: updated,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // Used by the create-employee screen: "does the department I'm adding this
    // person to already have a head?" — if not, the UI asks whether this new
    // employee should become the head.
    async getDepartmentHeadStatus(department_id) {
        try {
            const department = await DepartmentModel.findById(department_id);
            if (!department) {
                return { success: false, message: "Department not found" };
            }

            const hasHead = Boolean(department.head_employee_id);

            return {
                success: true,
                data: {
                    department_id: department.id,
                    department_name: department.department_name,
                    has_head: hasHead,
                    employee_count: department.employee_count,
                    // The UI should prompt "make this employee head of department?"
                    should_prompt_for_head: !hasHead,
                    head: hasHead
                        ? {
                            employee_id: department.head_employee_id,
                            first_name: department.head_first_name,
                            last_name: department.head_last_name,
                            email: department.head_email,
                            employee_code: department.head_employee_code,
                        }
                        : null,
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // Compliance report — every department that has employees but no head.
    async getDepartmentsMissingHead(company_id) {
        try {
            const rows = await DepartmentModel.findHeadlessWithEmployees(company_id);
            return {
                success: true,
                message: rows.length
                    ? `${rows.length} department(s) have employees but no head`
                    : "All departments with employees have a head",
                data: {
                    count: rows.length,
                    departments: rows.map((d) => ({
                        department_id: d.id,
                        department_name: d.department_name,
                        branch_id: d.branch_id,
                        employee_count: d.employee_count,
                    })),
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async deleteDepartment(id) {
        try {
            const result = await DepartmentModel.delete(id);
            if (!result) {
                return { success: false, message: "Department not found" };
            }
            return {
                success: true,
                message: "Department deleted successfully",
                data: result,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },
};

module.exports = DepartmentService;