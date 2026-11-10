const BranchModel = require("../models/branchModel");
const DepartmentModel = require("../models/departmentModel");
const ShiftModel = require("../models/shiftModel");

/**
 * Departments and shifts belong to exactly one branch, so an employee's
 * department and shift must come from the employee's own branch. Without this
 * an employee moved to a new branch keeps the old branch's shift, and their
 * attendance runs on the wrong timings.
 *
 * Returns an error message, or null when the assignment is valid. Null
 * department_id / shift_id mean "none" and are always valid.
 */
async function validateEmployeeAssignment({ company_id, branch_id, department_id, shift_id }) {
    if (!branch_id) return "Branch is required";

    const branch = await BranchModel.findById(branch_id);
    if (!branch || branch.company_id !== company_id) {
        return "Branch not found or does not belong to this company";
    }

    if (department_id) {
        const department = await DepartmentModel.findById(department_id);
        if (!department || department.company_id !== company_id) {
            return "Department not found or does not belong to this company";
        }
        if (department.branch_id !== branch_id) {
            return `"${department.department_name}" is not a department of ${branch.branch_name}. Choose a department from that branch.`;
        }
    }

    if (shift_id) {
        const shift = await ShiftModel.findById(shift_id);
        if (!shift || shift.company_id !== company_id) {
            return "Shift not found or does not belong to this company";
        }
        if (shift.branch_id !== branch_id) {
            return `"${shift.shift_name}" is not a shift of ${branch.branch_name}. Choose a shift from that branch.`;
        }
    }

    return null;
}

module.exports = { validateEmployeeAssignment };
