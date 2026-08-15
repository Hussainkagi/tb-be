const EmployeeModel = require("../models/employeeModel");
const CompanyModel = require("../models/companyModel");
const BranchModel = require("../models/branchModel");
const DepartmentModel = require("../models/departmentModel");
const LeaveRequestModel = require("../models/leaveRequestModel");
const DepartmentService = require("./departmentService");

// Employment states a list may be filtered to. `all` is the default so that
// adding the filter cannot change what an existing caller receives.
const EMPLOYEE_STATES = ["active", "former", "all"];

/**
 * Rejects an unknown state rather than silently ignoring it.
 *
 * A typo'd `?state=activ` that falls back to "all" looks like the filter is
 * broken — worse, on a headcount screen it silently over-reports.
 */
function validateEmployeeFilters({ state = null, status = null } = {}) {
    if (state !== null && state !== undefined && !EMPLOYEE_STATES.includes(state)) {
        return {
            success: false,
            message: `state must be one of: ${EMPLOYEE_STATES.join(", ")}`,
        };
    }

    return {
        success: true,
        data: {
            state: state || "all",
            status: status || null,
        },
    };
}

// An employee who leaves (deactivated / deleted) stops being head of their
// department. Returns the now-headless department when it still has employees,
// so the caller can tell the admin a replacement is needed.
async function releaseDepartmentHead(employee_id) {
    const headed = await DepartmentModel.findByHeadEmployee(employee_id);
    if (!headed) return null;

    await DepartmentModel.clearHead(headed.id);
    // Leave requests parked at the HOD stage fall through to the admin —
    // nobody is left to approve them otherwise.
    await LeaveRequestModel.releaseHodStageForDepartment(headed.id);

    const employee_count = await DepartmentModel.countEmployees(headed.id);
    if (employee_count === 0) return null;

    return {
        department_id: headed.id,
        department_name: headed.department_name,
        employee_count,
        message: `"${headed.department_name}" no longer has a head. Assign a new head of department.`,
    };
}

const EmployeeService = {

    async getEmployeeById(id) {
        try {
            const result = await EmployeeModel.findById(id);
            console.log("getEmployeeById result:", result);
            if (!result) {
                return { success: false, message: "Employee nots found" };
            }
            return { success: true, data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    /**
     * @param {object} [filters]  { state: 'active'|'former'|'all', status }
     *
     * `counts` rides along on the company-wide list so the UI can label its
     * filter chips ("Active 48 / Former 3") without a second request — and so a
     * user who filters to Active can still see that leavers exist rather than
     * assuming someone was deleted.
     */
    async getEmployeesByCompany(company_id, filters = {}) {
        try {
            const validated = validateEmployeeFilters(filters);
            if (!validated.success) return validated;

            const [result, counts] = await Promise.all([
                EmployeeModel.getAllByCompany(company_id, validated.data),
                EmployeeModel.countsByState(company_id),
            ]);

            return { success: true, data: result, counts, filters: validated.data };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async getEmployeesByBranch(company_id, branch_id, filters = {}) {
        try {
            const validated = validateEmployeeFilters(filters);
            if (!validated.success) return validated;

            const result = await EmployeeModel.getAllByBranch(company_id, branch_id, validated.data);
            return { success: true, data: result, filters: validated.data };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async getEmployeesByDepartment(company_id, department_id, filters = {}) {
        try {
            const validated = validateEmployeeFilters(filters);
            if (!validated.success) return validated;

            const result = await EmployeeModel.getAllByDepartment(company_id, department_id, validated.data);
            return { success: true, data: result, filters: validated.data };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async updateEmployee(id, data) {
        try {
            // Prevent these from being changed via a generic update
            delete data.company_id;
            delete data.user_id;
            delete data.employee_code;
            delete data.gross_salary;

            // Handled separately below — it lives on the departments table
            const makeDepartmentHead = data.is_department_head === true;
            delete data.is_department_head;

            const employee = await EmployeeModel.findById(id);
            if (!employee) {
                return { success: false, message: "Employee not found" };
            }

            if (data.branch_id) {
                const branch = await BranchModel.findById(data.branch_id);
                if (!branch || branch.company_id !== employee.company_id) {
                    return { success: false, message: "Branch not found or does not belong to this company" };
                }
            }

            // Moving out of a department they head — that department loses its head
            const movingDepartment =
                "department_id" in data && data.department_id !== employee.department_id;

            const result = await EmployeeModel.update(id, data);
            if (!result) {
                return { success: false, message: "Employee not found" };
            }

            let vacated_department = null;
            if (movingDepartment) {
                const headed = await DepartmentModel.findByHeadEmployee(id);
                if (headed) {
                    await DepartmentModel.clearHead(headed.id);
                    await LeaveRequestModel.releaseHodStageForDepartment(headed.id);
                    vacated_department = {
                        department_id: headed.id,
                        department_name: headed.department_name,
                        employee_count: await DepartmentModel.countEmployees(headed.id),
                    };
                }
            }

            let head_result = null;
            if (makeDepartmentHead) {
                head_result = await DepartmentService.setDepartmentHead(
                    result.department_id,
                    id
                );
            }

            return {
                success: true,
                message: "Employee updated successfully",
                data: result,
                // Present when the employee stopped heading their old department
                // and that department still has employees needing a new head.
                vacated_department,
                // Present when the update also tried to assign a head
                department_head_result: head_result,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async deactivateEmployee(id) {
        try {
            const result = await EmployeeModel.deactivate(id);
            if (!result) {
                return { success: false, message: "Employee not found" };
            }

            const vacated_department = await releaseDepartmentHead(id);

            return {
                success: true,
                message: "Employee deactivated successfully",
                data: result,
                vacated_department,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async deleteEmployee(id) {
        try {
            const result = await EmployeeModel.delete(id);
            if (!result) {
                return { success: false, message: "Employee not found" };
            }

            const vacated_department = await releaseDepartmentHead(id);

            return {
                success: true,
                message: "Employee deleted successfully",
                data: result,
                vacated_department,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },
    async getEmployeeByUserAndCompany(user_id, company_id) {
        try {
            const result = await EmployeeModel.findByUserAndCompany(user_id, company_id);
            if (!result) {
                return { success: false, message: "Employee nots found" };
            }
            return { success: true, data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },
};

module.exports = EmployeeService;