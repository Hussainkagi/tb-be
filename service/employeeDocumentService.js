const EmployeeDocumentModel = require("../models/employeeDocumentModel");
const EmployeeModel = require("../models/employeeModel");

const EmployeeDocumentService = {

    async addDocument(data) {
        try {
            const { employee_id, company_id, document_type, document_number } = data;

            // 1. Verify employee exists and belongs to this company
            const employee = await EmployeeModel.findById(employee_id);
            if (!employee || employee.company_id !== company_id) {
                return { success: false, message: "Employee not found in this company" };
            }

            // 2. Enforce one document per type per employee (mirrors DB unique constraint)
            const existing = await EmployeeDocumentModel.findByType(employee_id, document_type);
            if (existing) {
                return { success: false, message: `A '${document_type}' document already exists for this employee. Use update instead.` };
            }

            const result = await EmployeeDocumentModel.create(data);
            return {
                success: true,
                message: "Document added successfully",
                data: result,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async getDocumentById(id) {
        try {
            const result = await EmployeeDocumentModel.findById(id);
            if (!result) {
                return { success: false, message: "Document not found" };
            }
            return { success: true, data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async getDocumentsByEmployee(employee_id) {
        try {
            const result = await EmployeeDocumentModel.getAllByEmployee(employee_id);
            return { success: true, data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async getDocumentsByCompany(company_id) {
        try {
            const result = await EmployeeDocumentModel.getAllByCompany(company_id);
            return { success: true, data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // Used for renewal alerts — pass days_ahead to control the lookahead window
    async getExpiringSoon(company_id, days_ahead = 30) {
        try {
            const before_date = new Date(Date.now() + days_ahead * 24 * 60 * 60 * 1000);
            const result = await EmployeeDocumentModel.getExpiringSoon(company_id, before_date);
            return { success: true, data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async updateDocument(id, data) {
        try {
            // Prevent relation fields from being changed via a generic update
            delete data.employee_id;
            delete data.company_id;
            delete data.document_type; // type is immutable — delete and re-add if type is wrong

            const result = await EmployeeDocumentModel.update(id, data);
            if (!result) {
                return { success: false, message: "Document not found" };
            }
            return {
                success: true,
                message: "Document updated successfully",
                data: result,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async deactivateDocument(id) {
        try {
            const result = await EmployeeDocumentModel.deactivate(id);
            if (!result) {
                return { success: false, message: "Document not found" };
            }
            return {
                success: true,
                message: "Document deactivated successfully",
                data: result,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async deleteDocument(id) {
        try {
            const result = await EmployeeDocumentModel.delete(id);
            if (!result) {
                return { success: false, message: "Document not found" };
            }
            return {
                success: true,
                message: "Document deleted successfully",
                data: result,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },
};

module.exports = EmployeeDocumentService;