const db = require("../config/database");

const EmployeeDocument = {

    async create(data) {
        const {
            company_id,
            employee_id,
            document_type,
            document_number,
            issued_country = null,
            issued_date = null,
            expiry_date = null,
            file_url = null,
            file_name = null,
        } = data;

        const result = await db.query(
            `INSERT INTO employee_documents (
                company_id, employee_id,
                document_type, document_number,
                issued_country, issued_date, expiry_date,
                file_url, file_name
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
            [
                company_id, employee_id,
                document_type, document_number,
                issued_country, issued_date, expiry_date,
                file_url, file_name,
            ]
        );
        return result.rows[0];
    },

    async findById(id) {
        const result = await db.query(
            `SELECT * FROM employee_documents WHERE id = $1 AND deleted_at IS NULL`,
            [id]
        );
        return result.rows[0];
    },

    // Get one specific document type for an employee (e.g. their emirates_id)
    async findByType(employee_id, document_type) {
        const result = await db.query(
            `SELECT * FROM employee_documents
             WHERE employee_id = $1 AND document_type = $2 AND deleted_at IS NULL`,
            [employee_id, document_type]
        );
        return result.rows[0];
    },

    async getAllByEmployee(employee_id) {
        const result = await db.query(
            `SELECT * FROM employee_documents
             WHERE employee_id = $1 AND deleted_at IS NULL
             ORDER BY created_at DESC`,
            [employee_id]
        );
        return result.rows;
    },

    async getAllByCompany(company_id) {
        const result = await db.query(
            `SELECT * FROM employee_documents
             WHERE company_id = $1 AND deleted_at IS NULL
             ORDER BY created_at DESC`,
            [company_id]
        );
        return result.rows;
    },

    // Fetch documents expiring before a given date — for renewal alerts
    async getExpiringSoon(company_id, before_date) {
        const result = await db.query(
            `SELECT * FROM employee_documents
             WHERE company_id = $1
               AND expiry_date IS NOT NULL
               AND expiry_date <= $2
               AND deleted_at IS NULL
             ORDER BY expiry_date ASC`,
            [company_id, before_date]
        );
        return result.rows;
    },

    async update(id, data) {
        const updates = [];
        const values = [];
        let paramCount = 1;

        for (const [key, value] of Object.entries(data)) {
            updates.push(`${key} = $${paramCount}`);
            values.push(value);
            paramCount++;
        }

        values.push(id);
        const query = `UPDATE employee_documents SET ${updates.join(", ")}
                       WHERE id = $${paramCount}
                         AND deleted_at IS NULL
                       RETURNING *`;

        const result = await db.query(query, values);
        return result.rows[0];
    },

    async deactivate(id) {
        const result = await db.query(
            `UPDATE employee_documents SET is_active = false WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
            [id]
        );
        return result.rows[0];
    },

    // Soft delete
    async delete(id) {
        const result = await db.query(
            `UPDATE employee_documents SET deleted_at = NOW() WHERE id = $1 RETURNING *`,
            [id]
        );
        return result.rows[0];
    },
};

module.exports = EmployeeDocument;