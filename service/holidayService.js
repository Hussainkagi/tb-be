const HolidayModel = require("../models/holidayModel");
const BranchModel = require("../models/branchModel");
const NotificationService = require("./notificationService");

const HolidayService = {
    // --------------------------------------------------------
    // CREATE
    // --------------------------------------------------------

    async createHoliday(data) {
        try {
            const { company_id, branch_id, is_company_wide = false, holiday_start_date, holiday_end_date } = data;

            // If branch-scoped, verify branch exists and belongs to this company
            if (!is_company_wide) {
                if (!branch_id) {
                    return {
                        success: false,
                        message: "branch_id is required when is_company_wide is false",
                    };
                }

                const branch = await BranchModel.findById(branch_id);
                if (!branch) {
                    return {
                        success: false,
                        message: "Branch not found",
                    };
                }

                if (branch.company_id !== company_id) {
                    return {
                        success: false,
                        message: "Branch does not belong to this company",
                    };
                }
            }

            // Validate date range
            if (new Date(holiday_end_date) < new Date(holiday_start_date)) {
                return {
                    success: false,
                    message: "holiday_end_date cannot be before holiday_start_date",
                };
            }

            // Check for overlapping holidays
            // 1. If creating company-wide, block if any holiday exists on these dates (company-wide or any branch)
            // 2. If creating branch-specific, block if company-wide exists on these dates
            // 3. If creating branch-specific, allow if only other branches have holidays on these dates

            // Helper: get all holidays overlapping the requested range
            const overlappingHolidays = await HolidayModel.getByDateRange(
                company_id,
                null, // null branch_id to get all (company-wide + all branches)
                holiday_start_date,
                holiday_end_date
            );

            if (is_company_wide) {
                // Block if any holiday exists on these dates
                if (overlappingHolidays && overlappingHolidays.length > 0) {
                    return {
                        success: false,
                        message: "Cannot create company-wide holiday: a holiday already exists on these dates (company-wide or branch-specific)",
                    };
                }
            } else {
                // Check for company-wide holidays in the overlap
                const companyWideConflict = overlappingHolidays && overlappingHolidays.some(h => h.is_company_wide);
                if (companyWideConflict) {
                    return {
                        success: false,
                        message: "Cannot create branch-specific holiday: a company-wide holiday already exists on these dates.",
                    };
                }
                // Check for same-branch conflict
                const sameBranchConflict = overlappingHolidays && overlappingHolidays.some(h => h.branch_id === branch_id && !h.is_company_wide);
                if (sameBranchConflict) {
                    return {
                        success: false,
                        message: "Cannot create branch-specific holiday: a holiday for this branch already exists on these dates.",
                    };
                }
                // If only other branches have holidays, allow
            }

            const result = await HolidayModel.create({
                ...data,
                branch_id: is_company_wide ? null : branch_id,
            });

            const isSingleDay = holiday_start_date === holiday_end_date;
            const displayDate = isSingleDay
                ? holiday_start_date
                : `${holiday_start_date} – ${holiday_end_date}`;

            NotificationService.notifyHolidayCreated({
                company_id,
                branch_id: is_company_wide ? null : branch_id,
                holiday_id: result.id,
                holiday_name: result.holiday_name,
                holiday_date: displayDate,
                is_company_wide,
            }).catch((err) =>
                console.error("[Notification] notifyHolidayCreated failed:", err.message)
            );

            return {
                success: true,
                message: "Holiday created successfully",
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

    // --------------------------------------------------------
    // READ — single record
    // --------------------------------------------------------

    async getHolidayById(id) {
        try {
            const result = await HolidayModel.findById(id);
            if (!result) {
                return {
                    success: false,
                    message: "Holiday not found",
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

    // --------------------------------------------------------
    // READ — company scope
    // --------------------------------------------------------

    async getAllByCompany(company_id) {
        try {
            const result = await HolidayModel.getAllByCompany(company_id);
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

    async getCompanyWideHolidays(company_id) {
        try {
            const result = await HolidayModel.getCompanyWide(company_id);
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

    // --------------------------------------------------------
    // READ — branch scope
    // --------------------------------------------------------

    // Returns company-wide + branch-specific holidays merged
    // This is the main API for attendance / employee-facing views
    async getAllByBranch(company_id, branch_id) {
        try {
            const branch = await BranchModel.findById(branch_id);
            if (!branch) {
                return {
                    success: false,
                    message: "Branch not found",
                };
            }

            if (branch.company_id !== company_id) {
                return {
                    success: false,
                    message: "Branch does not belong to this company",
                };
            }

            const result = await HolidayModel.getAllByBranch(company_id, branch_id);
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

    async getBranchSpecificHolidays(company_id, branch_id) {
        try {
            const branch = await BranchModel.findById(branch_id);
            if (!branch) {
                return {
                    success: false,
                    message: "Branch not found",
                };
            }

            if (branch.company_id !== company_id) {
                return {
                    success: false,
                    message: "Branch does not belong to this company",
                };
            }

            const result = await HolidayModel.getBranchSpecific(company_id, branch_id);
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

    // --------------------------------------------------------
    // READ — date / attendance helpers
    // --------------------------------------------------------

    async checkIsHoliday(company_id, branch_id, date) {
        try {
            const isHoliday = await HolidayModel.isHoliday(company_id, branch_id, date);
            return {
                success: true,
                data: { is_holiday: isHoliday, date, branch_id, company_id },
            };
        } catch (error) {
            return {
                success: false,
                message: error.message,
                error: error,
            };
        }
    },

    async getHolidaysByDateRange(company_id, branch_id, from_date, to_date) {
        try {
            if (new Date(to_date) < new Date(from_date)) {
                return {
                    success: false,
                    message: "to_date cannot be before from_date",
                };
            }

            const result = await HolidayModel.getByDateRange(
                company_id,
                branch_id,
                from_date,
                to_date
            );
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

    // --------------------------------------------------------
    // UPDATE
    // --------------------------------------------------------

    async updateHoliday(id, data) {
        try {
            // Prevent changing scope-related fields via update
            // to avoid violating the DB CHECK constraint
            const { is_company_wide, branch_id, ...safeData } = data;

            if (is_company_wide !== undefined || branch_id !== undefined) {
                return {
                    success: false,
                    message:
                        "Cannot change is_company_wide or branch_id via update. Delete and recreate the holiday instead.",
                };
            }

            // Validate date range if both dates are being updated
            if (safeData.holiday_start_date && safeData.holiday_end_date) {
                if (
                    new Date(safeData.holiday_end_date) <
                    new Date(safeData.holiday_start_date)
                ) {
                    return {
                        success: false,
                        message: "holiday_end_date cannot be before holiday_start_date",
                    };
                }
            }

            const result = await HolidayModel.update(id, safeData);
            if (!result) {
                return {
                    success: false,
                    message: "Holiday not found",
                };
            }
            return {
                success: true,
                message: "Holiday updated successfully",
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

    async deactivateHoliday(id) {
        try {
            const result = await HolidayModel.deactivate(id);
            if (!result) {
                return {
                    success: false,
                    message: "Holiday not found",
                };
            }
            return {
                success: true,
                message: "Holiday deactivated successfully",
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

    async activateHoliday(id) {
        try {
            const result = await HolidayModel.activate(id);
            if (!result) {
                return {
                    success: false,
                    message: "Holiday not found",
                };
            }
            return {
                success: true,
                message: "Holiday activated successfully",
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

    // --------------------------------------------------------
    // DELETE — soft delete
    // --------------------------------------------------------

    async deleteHoliday(id) {
        try {
            const result = await HolidayModel.delete(id);
            if (!result) {
                return {
                    success: false,
                    message: "Holiday not found",
                };
            }
            return {
                success: true,
                message: "Holiday deleted successfully",
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

module.exports = HolidayService;