const EmployeeSalaryStructureModel = require("../models/employeeSalaryStructureModel");
const EmployeeModel = require("../models/employeeModel");

const EmployeeSalaryStructureService = {

    async getSalaryStructureById(id) {
        try {
            const result = await EmployeeSalaryStructureModel.findById(id);
            if (!result) {
                return { success: false, message: "Salary structure not found" };
            }
            return { success: true, data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async getActiveSalaryStructure(employee_id) {
        try {
            const result = await EmployeeSalaryStructureModel.findActiveByEmployee(employee_id);
            if (!result) {
                return { success: false, message: "No active salary structure found for this employee" };
            }
            return { success: true, data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async getSalaryHistoryByEmployee(employee_id) {
        try {
            const result = await EmployeeSalaryStructureModel.getAllByEmployee(employee_id);
            return { success: true, data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async getSalaryStructuresByCompany(company_id) {
        try {
            const result = await EmployeeSalaryStructureModel.getAllByCompany(company_id);
            return { success: true, data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async createSalaryStructure(data) {
        try {
            const { company_id, employee_id, effective_from } = data;

            if (!company_id || !employee_id || !effective_from) {
                return { success: false, message: "company_id, employee_id, and effective_from are required" };
            }

            // Verify employee exists and belongs to the same company
            const employee = await EmployeeModel.findById(employee_id);
            if (!employee) {
                return { success: false, message: "Employee not found" };
            }
            if (employee.company_id !== company_id) {
                return { success: false, message: "Employee does not belong to this company" };
            }

            // Deactivate any currently active structures before creating a new one
            await EmployeeSalaryStructureModel.deactivateAllByEmployee(employee_id);

            const result = await EmployeeSalaryStructureModel.create(data);
            return {
                success: true,
                message: "Salary structure created successfully",
                data: result,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async updateSalaryStructure(id, data) {
        try {
            // Prevent changing ownership fields
            delete data.company_id;
            delete data.employee_id;

            const existing = await EmployeeSalaryStructureModel.findById(id);
            if (!existing) {
                return { success: false, message: "Salary structure not found" };
            }

            const result = await EmployeeSalaryStructureModel.update(id, data);
            if (!result) {
                return { success: false, message: "Salary structure not found" };
            }
            return {
                success: true,
                message: "Salary structure updated successfully",
                data: result,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async deactivateSalaryStructure(id) {
        try {
            const result = await EmployeeSalaryStructureModel.deactivate(id);
            if (!result) {
                return { success: false, message: "Salary structure not found" };
            }
            return {
                success: true,
                message: "Salary structure deactivated successfully",
                data: result,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async deleteSalaryStructure(id) {
        try {
            const result = await EmployeeSalaryStructureModel.delete(id);
            if (!result) {
                return { success: false, message: "Salary structure not found" };
            }
            return {
                success: true,
                message: "Salary structure deleted successfully",
                data: result,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },
};

module.exports = EmployeeSalaryStructureService;