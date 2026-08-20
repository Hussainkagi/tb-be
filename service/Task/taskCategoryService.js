const { TaskCategoryModel, DEFAULT_TASK_CATEGORIES } = require("../../models/Task/taskCategoryModel");
const CompanyModel = require("../../models/companyModel");

/**
 * Task categories.
 *
 * Companies create their own buckets — Bug, Feature, Operations and whatever
 * else the business actually tracks. Mirrors leaveTypeService: seeded
 * defaults on first use, then fully owned by the company.
 */

const TaskCategoryService = {
    // --------------------------------------------------------
    // READ — onboarding check (show/hide the seed button)
    // --------------------------------------------------------

    async checkCategoriesExist(company_id) {
        try {
            const exists = await TaskCategoryModel.hasCategories(company_id);
            return { success: true, data: { has_categories: exists } };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // --------------------------------------------------------
    // CREATE — seed defaults
    // --------------------------------------------------------

    async seedDefaults(company_id) {
        try {
            const company = await CompanyModel.findById(company_id);
            if (!company) return { success: false, message: "Company not found" };

            const created = await TaskCategoryModel.seedDefaults(company_id);

            return {
                success: true,
                message: created.length
                    ? `${created.length} default task categories created successfully`
                    : "All default task categories already exist for this company",
                data: created,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // --------------------------------------------------------
    // CREATE
    // --------------------------------------------------------

    async createCategory(data) {
        try {
            const { company_id, name } = data;

            if (!name || !String(name).trim()) {
                return { success: false, message: "name is required" };
            }
            if (data.color_hex && !/^#[0-9A-Fa-f]{6}$/.test(data.color_hex)) {
                return { success: false, message: "color_hex must be a #RRGGBB value" };
            }

            const created = await TaskCategoryModel.create({
                ...data,
                name: String(name).trim(),
            });

            return { success: true, message: "Task category created successfully", data: created };
        } catch (error) {
            // 23505 = the case-insensitive unique index on (company_id, name)
            if (error.code === "23505") {
                return { success: false, message: "A task category with this name already exists." };
            }
            return { success: false, message: error.message, error };
        }
    },

    // --------------------------------------------------------
    // READ
    // --------------------------------------------------------

    async getAllByCompany(company_id, { activeOnly = false } = {}) {
        try {
            return { success: true, data: await TaskCategoryModel.findByCompany(company_id, { activeOnly }) };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async getById(company_id, id) {
        try {
            const category = await TaskCategoryModel.findById(id);
            if (!category || category.company_id !== company_id) {
                return { success: false, status: 404, message: "Task category not found" };
            }
            return { success: true, data: category };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // --------------------------------------------------------
    // UPDATE
    // --------------------------------------------------------

    async updateCategory(company_id, id, data) {
        try {
            const category = await TaskCategoryModel.findById(id);
            if (!category || category.company_id !== company_id) {
                return { success: false, status: 404, message: "Task category not found" };
            }
            if (data.color_hex && !/^#[0-9A-Fa-f]{6}$/.test(data.color_hex)) {
                return { success: false, message: "color_hex must be a #RRGGBB value" };
            }

            const updated = await TaskCategoryModel.update(id, data);
            return { success: true, message: "Task category updated successfully", data: updated };
        } catch (error) {
            if (error.code === "23505") {
                return { success: false, message: "A task category with this name already exists." };
            }
            return { success: false, message: error.message, error };
        }
    },

    // --------------------------------------------------------
    // DELETE — soft
    // --------------------------------------------------------

    /**
     * Deleting a category leaves its finished tasks filed under a category
     * that no longer lists (category_id survives, the join just returns the
     * deleted row's name as NULL). Live work is different: it would lose its
     * classification while people are still looking at it, so it blocks.
     */
    async deleteCategory(company_id, id) {
        try {
            const category = await TaskCategoryModel.findById(id);
            if (!category || category.company_id !== company_id) {
                return { success: false, status: 404, message: "Task category not found" };
            }

            const openTasks = await TaskCategoryModel.countOpenTasks(id);
            if (openTasks > 0) {
                return {
                    success: false,
                    message: `${openTasks} unfinished task(s) still use this category. Move them first, or deactivate the category instead of deleting it.`,
                };
            }

            return {
                success: true,
                message: "Task category deleted successfully",
                data: await TaskCategoryModel.softDelete(id),
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    /** Defaults, so the panel can show what seeding will create. */
    listDefaults() {
        return { success: true, data: DEFAULT_TASK_CATEGORIES };
    },
};

module.exports = TaskCategoryService;
