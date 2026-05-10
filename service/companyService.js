const CompanyModel = require("../models/companyModel");

const CompanyService = {
    async createCompany(data) {
        try {
            const existing = await CompanyModel.findByEmail(data.email);
            if (existing) {
                return {
                    success: false,
                    message: "A company with this email already exists",
                };
            }

            const codeExists = await CompanyModel.findByCode(data.company_code);
            if (codeExists) {
                return {
                    success: false,
                    message: "Company code already taken",
                };
            }

            const result = await CompanyModel.create(data);
            return {
                success: true,
                message: "Company created successfully",
                data: result,
            };
        } catch (error) {
            return {
                success: false,
                message: error.message,
                error: error,
            };
        }
    },

    async getCompanyById(id) {
        try {
            const result = await CompanyModel.findById(id);
            if (!result) {
                return {
                    success: false,
                    message: "Company not found",
                };
            }
            return {
                success: true,
                data: result,
            };
        } catch (error) {
            return {
                success: false,
                message: error.message,
                error: error,
            };
        }
    },

    async getCompanyByCode(company_code) {
        try {
            const result = await CompanyModel.findByCode(company_code);
            if (!result) {
                return {
                    success: false,
                    message: "Company not found",
                };
            }
            return {
                success: true,
                data: result,
            };
        } catch (error) {
            return {
                success: false,
                message: error.message,
                error: error,
            };
        }
    },

    async getAllCompanies() {
        try {
            const result = await CompanyModel.getAll();
            return {
                success: true,
                data: result,
            };
        } catch (error) {
            return {
                success: false,
                message: error.message,
                error: error,
            };
        }
    },

    async updateCompany(id, data) {
        try {
            const result = await CompanyModel.update(id, data);
            if (!result) {
                return {
                    success: false,
                    message: "Company not found",
                };
            }
            return {
                success: true,
                message: "Company updated successfully",
                data: result,
            };
        } catch (error) {
            return {
                success: false,
                message: error.message,
                error: error,
            };
        }
    },

    async updateCompanyPlan(id, plan, plan_expires_at) {
        try {
            const result = await CompanyModel.updatePlan(id, plan, plan_expires_at);
            if (!result) {
                return {
                    success: false,
                    message: "Company not found",
                };
            }
            return {
                success: true,
                message: "Company plan updated successfully",
                data: result,
            };
        } catch (error) {
            return {
                success: false,
                message: error.message,
                error: error,
            };
        }
    },

    async deactivateCompany(id) {
        try {
            const result = await CompanyModel.deactivate(id);
            if (!result) {
                return {
                    success: false,
                    message: "Company not found",
                };
            }
            return {
                success: true,
                message: "Company deactivated successfully",
                data: result,
            };
        } catch (error) {
            return {
                success: false,
                message: error.message,
                error: error,
            };
        }
    },

    async deleteCompany(id) {
        try {
            const result = await CompanyModel.delete(id);
            if (!result) {
                return {
                    success: false,
                    message: "Company not found",
                };
            }
            return {
                success: true,
                message: "Company deleted successfully",
                data: result,
            };
        } catch (error) {
            return {
                success: false,
                message: error.message,
                error: error,
            };
        }
    },
};

module.exports = CompanyService;