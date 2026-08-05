const EmployeeBankAccountModel = require("../models/employeeBankAccountModel");
const EmployeeModel = require("../models/employeeModel");
const { validateBankDetails } = require("../utils/bankDetailsValidator");
const { getSpec, listCountries } = require("../enums/bankFieldSpecs");

/**
 * Employee bank accounts.
 *
 * Bank details are always OPTIONAL. They can be managed directly through these
 * endpoints, or supplied inline when creating a salary structure — both paths
 * funnel through `upsertPrimary` so validation is identical.
 */

const EmployeeBankAccountService = {
    /**
     * Field spec for a country, so the frontend can render the right form.
     * Any ISO2 code works; unknown ones get the generic international form.
     */
    async getFieldSpec(country_code) {
        try {
            if (!country_code) {
                return {
                    success: true,
                    data: { countries: listCountries() },
                };
            }

            const spec = getSpec(country_code);
            return {
                success: true,
                data: {
                    country_code: spec.country_code,
                    country_name: spec.country_name,
                    default_currency: spec.default_currency,
                    is_generic: spec.is_generic,
                    fields: spec.fields,
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    /**
     * Creates or updates an employee's primary bank account.
     * Used by the standalone endpoint AND by the salary-structure flow.
     */
    async upsertPrimary(company_id, employee_id, work_country, bank_details = {}) {
        try {
            const employee = await EmployeeModel.findById(employee_id);
            if (!employee) return { success: false, message: "Employee not found" };
            if (String(employee.company_id) !== String(company_id)) {
                return { success: false, message: "Employee does not belong to this company" };
            }

            const { valid, errors, data } = validateBankDetails(work_country, bank_details);
            if (!valid) {
                return {
                    success: false,
                    message: "Bank details validation failed",
                    errors,
                };
            }

            const existing = await EmployeeBankAccountModel.findPrimaryByEmployee(employee_id);

            const account = existing
                ? await EmployeeBankAccountModel.update(existing.id, data)
                : await EmployeeBankAccountModel.create({
                      ...data,
                      company_id,
                      employee_id,
                      is_primary: true,
                  });

            return {
                success: true,
                message: existing
                    ? "Bank details updated successfully"
                    : "Bank details added successfully",
                data: account,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async getPrimary(employee_id) {
        try {
            const account = await EmployeeBankAccountModel.findPrimaryByEmployee(employee_id);
            if (!account) {
                return { success: false, message: "No bank details on file for this employee" };
            }
            return { success: true, data: account };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async listByEmployee(employee_id) {
        try {
            const rows = await EmployeeBankAccountModel.getAllByEmployee(employee_id);
            return { success: true, data: rows };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async listByCompany(company_id, query = {}) {
        try {
            const rows = await EmployeeBankAccountModel.getAllByCompany(company_id, {
                work_country: query.work_country || null,
            });
            const byCountry = await EmployeeBankAccountModel.countByCountry(company_id);
            return {
                success: true,
                data: rows,
                meta: {
                    by_country: byCountry.map((r) => ({
                        ...r,
                        employee_count: Number(r.employee_count),
                    })),
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async update(id, company_id, payload = {}) {
        try {
            const existing = await EmployeeBankAccountModel.findById(id);
            if (!existing) return { success: false, message: "Bank account not found" };
            if (String(existing.company_id) !== String(company_id)) {
                return { success: false, message: "Bank account does not belong to this company" };
            }

            // Changing country re-validates against the new country's format.
            const country = payload.work_country || existing.work_country;

            // Merge so a partial update doesn't wipe fields the caller omitted.
            const merged = { ...existing, ...(existing.extra || {}), ...payload };

            const { valid, errors, data } = validateBankDetails(country, merged);
            if (!valid) {
                return { success: false, message: "Bank details validation failed", errors };
            }

            const updated = await EmployeeBankAccountModel.update(id, data);
            return { success: true, message: "Bank details updated successfully", data: updated };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async remove(id, company_id) {
        try {
            const existing = await EmployeeBankAccountModel.findById(id);
            if (!existing) return { success: false, message: "Bank account not found" };
            if (String(existing.company_id) !== String(company_id)) {
                return { success: false, message: "Bank account does not belong to this company" };
            }

            const deleted = await EmployeeBankAccountModel.softDelete(id);
            return { success: true, message: "Bank details removed successfully", data: deleted };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },
};

module.exports = EmployeeBankAccountService;
