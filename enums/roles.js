/**
 * HRMS Role Enums
 * 0: Admin | 1: Manager | 2: Employee
 */
const Role = Object.freeze({
    ADMIN: 0,
    MANAGER: 1,
    EMPLOYEE: 2,
});

const RoleLabel = Object.freeze({
    [Role.ADMIN]: "Admin",
    [Role.MANAGER]: "Manager",
    [Role.EMPLOYEE]: "Employee",
});

module.exports = { Role, RoleLabel };