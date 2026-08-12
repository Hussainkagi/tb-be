const OrgChartModel = require("../models/orgChartModel");
const CompanyModel = require("../models/companyModel");

const toNode = (row, node_type) => ({
    id: row.id,
    node_type,                       // "admin" | "department_head" | "employee"
    employee_id: row.id,
    employee_code: row.employee_code,
    first_name: row.first_name,
    last_name: row.last_name,
    full_name: `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim(),
    email: row.email,
    phone: row.phone,
    status: row.status,
    role: row.role ?? null,
    department_id: row.department_id ?? null,
    branch_id: row.branch_id ?? null,
});

const OrgChartService = {
    // Company org tree for the company-profile page:
    //
    //   company
    //     └── admin(s)
    //           └── branch
    //                 └── department
    //                       ├── head of department
    //                       └── employees of that department
    //                 └── (branch employees with no department)
    //     └── (employees with no branch at all)
    //
    async getCompanyOrgChart(company_id, { branch_id = null } = {}) {
        try {
            const company = await CompanyModel.findById(company_id);
            if (!company) {
                return { success: false, message: "Company not found" };
            }

            const [admins, branches, departments, employees] = await Promise.all([
                OrgChartModel.findAdmins(company_id),
                OrgChartModel.findBranches(company_id, branch_id),
                OrgChartModel.findDepartments(company_id, branch_id),
                OrgChartModel.findEmployees(company_id, branch_id),
            ]);

            const adminIds = new Set(admins.map((a) => a.id));
            const branchIds = new Set(branches.map((b) => b.id));

            // Bucket employees once — avoids a filter pass per department/branch.
            //   byDepartment      → employees that have a department
            //   noDepartment      → employees of a branch, but no department
            //   unassigned        → no branch at all (or a branch outside the filter)
            const byDepartment = new Map();
            const noDepartmentByBranch = new Map();
            const unassigned = [];
            for (const employee of employees) {
                if (adminIds.has(employee.id)) continue;   // admins sit at the top level
                if (employee.department_id) {
                    if (!byDepartment.has(employee.department_id)) {
                        byDepartment.set(employee.department_id, []);
                    }
                    byDepartment.get(employee.department_id).push(employee);
                    continue;
                }
                if (employee.branch_id && branchIds.has(employee.branch_id)) {
                    if (!noDepartmentByBranch.has(employee.branch_id)) {
                        noDepartmentByBranch.set(employee.branch_id, []);
                    }
                    noDepartmentByBranch.get(employee.branch_id).push(employee);
                    continue;
                }
                unassigned.push(employee);
            }

            const departmentNodes = departments.map((d) => {
                const members = byDepartment.get(d.id) ?? [];
                const head = d.head_employee_id
                    ? {
                        id: d.head_employee_id,
                        node_type: "department_head",
                        employee_id: d.head_employee_id,
                        employee_code: d.head_employee_code,
                        first_name: d.head_first_name,
                        last_name: d.head_last_name,
                        full_name: `${d.head_first_name ?? ""} ${d.head_last_name ?? ""}`.trim(),
                        email: d.head_email,
                        status: d.head_status,
                        department_id: d.id,
                        branch_id: d.branch_id,
                    }
                    : null;

                return {
                    id: d.id,
                    node_type: "department",
                    department_id: d.id,
                    department_name: d.department_name,
                    branch_id: d.branch_id,
                    branch_name: d.branch_name,
                    head,
                    // A department is only in violation when it has employees
                    // but no head — an empty department may stay headless.
                    needs_head: !d.head_employee_id && members.length > 0,
                    employee_count: members.length,
                    // Head is rendered as the department's own node, so it is
                    // excluded from the children list.
                    children: members
                        .filter((e) => e.id !== d.head_employee_id)
                        .map((e) => toNode(e, "employee")),
                };
            });

            const departmentsByBranch = new Map();
            for (const node of departmentNodes) {
                if (!departmentsByBranch.has(node.branch_id)) {
                    departmentsByBranch.set(node.branch_id, []);
                }
                departmentsByBranch.get(node.branch_id).push(node);
            }

            const branchNodes = branches.map((b) => {
                const branchDepartments = departmentsByBranch.get(b.id) ?? [];
                const branchOnly = noDepartmentByBranch.get(b.id) ?? [];

                return {
                    id: b.id,
                    node_type: "branch",
                    branch_id: b.id,
                    branch_name: b.branch_name,
                    branch_code: b.branch_code,
                    is_head_office: b.is_head_office,
                    city: b.city,
                    country: b.country,
                    is_active: b.is_active,
                    department_count: branchDepartments.length,
                    employee_count:
                        branchDepartments.reduce((sum, d) => sum + d.employee_count, 0) +
                        branchOnly.length,
                    children: branchDepartments,
                    // Employees attached to the branch but to no department
                    unassigned_employees: branchOnly.map((e) => toNode(e, "employee")),
                };
            });

            const tree = {
                id: company.id,
                node_type: "company",
                name: company.company_name,
                logo_url: company.logo_url ?? null,
                children: admins.map((a) => ({
                    ...toNode(a, "admin"),
                    // Every branch hangs under each admin so the UI can draw a
                    // single-rooted tree; with one admin (the usual case) this is
                    // exactly the admin → branches → heads → employees shape.
                    children: branchNodes,
                })),
                branches: branchNodes,
                // Flat department list across branches — handy for lookups/filters
                departments: departmentNodes,
                // Employees with no branch at all
                unassigned_employees: unassigned.map((e) => toNode(e, "employee")),
            };

            return {
                success: true,
                data: {
                    tree,
                    summary: {
                        admin_count: admins.length,
                        branch_count: branchNodes.length,
                        department_count: departmentNodes.length,
                        employee_count: employees.length,
                        unassigned_employee_count:
                            unassigned.length +
                            branchNodes.reduce((sum, b) => sum + b.unassigned_employees.length, 0),
                        departments_missing_head: departmentNodes
                            .filter((d) => d.needs_head)
                            .map((d) => ({
                                department_id: d.department_id,
                                department_name: d.department_name,
                                branch_id: d.branch_id,
                                branch_name: d.branch_name,
                                employee_count: d.employee_count,
                            })),
                    },
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },
};

module.exports = OrgChartService;
