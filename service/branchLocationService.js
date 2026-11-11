const BranchModel = require("../models/branchModel");
const BranchLocationModel = require("../models/branchLocationModel");

const EDITABLE = ["location_name", "address", "latitude", "longitude", "attendance_radius", "is_active"];

/** Returns an error message, or null. `partial` skips required checks for updates. */
function validate(data, { partial = false } = {}) {
    if (!partial || "location_name" in data) {
        if (!String(data.location_name ?? "").trim()) return "Location name is required";
        if (String(data.location_name).trim().length > 150) return "Location name must be 150 characters or fewer";
    }
    if (!partial || "latitude" in data) {
        const lat = Number(data.latitude);
        if (data.latitude === null || data.latitude === "" || !Number.isFinite(lat) || lat < -90 || lat > 90) {
            return "Latitude must be between -90 and 90";
        }
    }
    if (!partial || "longitude" in data) {
        const lng = Number(data.longitude);
        if (data.longitude === null || data.longitude === "" || !Number.isFinite(lng) || lng < -180 || lng > 180) {
            return "Longitude must be between -180 and 180";
        }
    }
    if ("attendance_radius" in data) {
        const r = Number(data.attendance_radius);
        if (!Number.isInteger(r) || r < 10 || r > 10000) return "Radius must be a whole number of metres between 10 and 10000";
    }
    if ("is_active" in data && typeof data.is_active !== "boolean") return "is_active must be true or false";
    return null;
}

const clean = (data) => {
    const out = Object.fromEntries(Object.entries(data ?? {}).filter(([k]) => EDITABLE.includes(k)));
    if ("location_name" in out) out.location_name = String(out.location_name).trim();
    if ("address" in out) out.address = out.address ? String(out.address).trim() : null;
    for (const k of ["latitude", "longitude"]) if (k in out) out[k] = Number(out[k]);
    if ("attendance_radius" in out) out.attendance_radius = Number(out.attendance_radius);
    return out;
};

const isDuplicateName = (error) => error?.code === "23505";

async function branchOfCompany(company_id, branch_id) {
    const branch = await BranchModel.findById(branch_id);
    return branch && String(branch.company_id) === String(company_id) ? branch : null;
}

async function siteOfBranch(company_id, branch_id, location_id) {
    const site = await BranchLocationModel.findById(location_id);
    return site && String(site.company_id) === String(company_id) && String(site.branch_id) === String(branch_id)
        ? site
        : null;
}

const BranchLocationService = {
    async list(company_id, branch_id) {
        try {
            if (!(await branchOfCompany(company_id, branch_id))) {
                return { success: false, status: 404, message: "Branch not found" };
            }
            return { success: true, data: await BranchLocationModel.findAllByBranch(branch_id) };
        } catch (error) {
            return { success: false, status: 500, message: error.message };
        }
    },

    async create(company_id, branch_id, body) {
        try {
            if (!(await branchOfCompany(company_id, branch_id))) {
                return { success: false, status: 404, message: "Branch not found" };
            }
            const data = clean(body);
            const error = validate(data);
            if (error) return { success: false, status: 400, message: error };

            const site = await BranchLocationModel.create({ ...data, company_id, branch_id });
            return { success: true, message: "Location added", data: site };
        } catch (error) {
            if (isDuplicateName(error)) {
                return { success: false, status: 409, message: "This branch already has a location with that name" };
            }
            return { success: false, status: 500, message: error.message };
        }
    },

    async update(company_id, branch_id, location_id, body) {
        try {
            if (!(await siteOfBranch(company_id, branch_id, location_id))) {
                return { success: false, status: 404, message: "Location not found" };
            }
            const data = clean(body);
            if (Object.keys(data).length === 0) {
                return { success: false, status: 400, message: `Nothing to update. Editable fields: ${EDITABLE.join(", ")}` };
            }
            const error = validate(data, { partial: true });
            if (error) return { success: false, status: 400, message: error };

            const site = await BranchLocationModel.update(location_id, data);
            return { success: true, message: "Location updated", data: site };
        } catch (error) {
            if (isDuplicateName(error)) {
                return { success: false, status: 409, message: "This branch already has a location with that name" };
            }
            return { success: false, status: 500, message: error.message };
        }
    },

    async remove(company_id, branch_id, location_id) {
        try {
            if (!(await siteOfBranch(company_id, branch_id, location_id))) {
                return { success: false, status: 404, message: "Location not found" };
            }
            await BranchLocationModel.softDelete(location_id);
            return { success: true, message: "Location removed" };
        } catch (error) {
            return { success: false, status: 500, message: error.message };
        }
    },
};

module.exports = BranchLocationService;
module.exports.validate = validate;
