const EmployeeSalaryStructureModel = require("../models/employeeSalaryStructureModel");
const EmployeeModel = require("../models/employeeModel");
const CompanyModel = require("../models/companyModel");
const EmployeeBankAccountModel = require("../models/employeeBankAccountModel");
const EmployeeBankAccountService = require("./employeeBankAccountService");
const { normalizeCountry } = require("../utils/bankDetailsValidator");
const { resolveCountryCode } = require("../enums/bankFieldSpecs");

/**
 * Resolves the optional bank details attached to a salary structure.
 *
 * Rules:
 *   - `bank_details` omitted  → carry forward the employee's existing primary
 *     account (so a raise doesn't lose their payout details); null if none.
 *   - `bank_details` supplied → validate against work_country and upsert.
 *
 * Returns { ok: true, bank_account_id } or { ok: false, ... } on validation failure.
 */
async function resolveBankAccount(company_id, employee_id, work_country, bank_details) {
    const hasDetails =
        bank_details && typeof bank_details === "object" && Object.keys(bank_details).length > 0;

    if (!hasDetails) {
        const existing = await EmployeeBankAccountModel.findPrimaryByEmployee(employee_id);
        return { ok: true, bank_account_id: existing ? existing.id : null };
    }

    const result = await EmployeeBankAccountService.upsertPrimary(
        company_id,
        employee_id,
        work_country,
        bank_details
    );

    if (!result.success) {
        return { ok: false, message: result.message, errors: result.errors };
    }

    return { ok: true, bank_account_id: result.data.id };
}

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
            const { company_id, employee_id, effective_from, bank_details = null } = data;

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

            const company = await CompanyModel.findById(company_id);
            if (!company) {
                return { success: false, message: "Company not found" };
            }

            // Salary amounts are ALWAYS in the company's own currency. Snapshot it
            // rather than trusting client input, so history survives a currency change.
            const salary_currency = company.currency;
            if (data.salary_currency && data.salary_currency !== salary_currency) {
                return {
                    success: false,
                    message: `Salary must be entered in the company currency (${salary_currency}). Received "${data.salary_currency}".`,
                };
            }

            // Where the employee works from — drives the bank-detail format only.
            // Defaults to the company's own country. companies.country is free text
            // ("United Arab Emirates"), so it needs resolving to an ISO2 code.
            const work_country =
                normalizeCountry(data.work_country) || resolveCountryCode(company.country) || null;

            const hasBankDetails =
                bank_details && typeof bank_details === "object" && Object.keys(bank_details).length > 0;

            if (hasBankDetails && !work_country) {
                return {
                    success: false,
                    message:
                        "work_country is required when bank details are provided (2-letter ISO code, e.g. AE, IN)",
                };
            }

            const bank = await resolveBankAccount(
                company_id,
                employee_id,
                work_country,
                bank_details
            );
            if (!bank.ok) {
                return { success: false, message: bank.message, errors: bank.errors };
            }

            // Deactivate any currently active structures before creating a new one
            await EmployeeSalaryStructureModel.deactivateAllByEmployee(employee_id);

            const { bank_details: _omit, ...salaryFields } = data;

            const result = await EmployeeSalaryStructureModel.create({
                ...salaryFields,
                work_country,
                salary_currency,
                bank_account_id: bank.bank_account_id,
            });

            // Re-read so the response carries the joined bank_account object.
            const full = await EmployeeSalaryStructureModel.findById(result.id);

            return {
                success: true,
                message: "Salary structure created successfully",
                data: full || result,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async updateSalaryStructure(id, data) {
        try {
            // Prevent changing ownership fields and the currency snapshot
            delete data.company_id;
            delete data.employee_id;
            delete data.salary_currency;

            const existing = await EmployeeSalaryStructureModel.findById(id);
            if (!existing) {
                return { success: false, message: "Salary structure not found" };
            }

            const { bank_details = null, ...salaryFields } = data;

            const work_country =
                normalizeCountry(salaryFields.work_country) || existing.work_country || null;

            const hasBankDetails =
                bank_details && typeof bank_details === "object" && Object.keys(bank_details).length > 0;

            if (hasBankDetails) {
                if (!work_country) {
                    return {
                        success: false,
                        message:
                            "work_country is required when bank details are provided (2-letter ISO code, e.g. AE, IN)",
                    };
                }

                const bank = await resolveBankAccount(
                    existing.company_id,
                    existing.employee_id,
                    work_country,
                    bank_details
                );
                if (!bank.ok) {
                    return { success: false, message: bank.message, errors: bank.errors };
                }
                salaryFields.bank_account_id = bank.bank_account_id;
            }

            if (work_country) salaryFields.work_country = work_country;

            const result = await EmployeeSalaryStructureModel.update(id, salaryFields);
            if (!result) {
                return { success: false, message: "Salary structure not found" };
            }

            const full = await EmployeeSalaryStructureModel.findById(id);

            return {
                success: true,
                message: "Salary structure updated successfully",
                data: full || result,
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