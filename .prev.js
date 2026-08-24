require("dotenv").config();
process.on("unhandledRejection", (e) => { console.error("UNHANDLED:", e.message); process.exit(1); });
const db = require("./config/database");
const PS = require("./service/payrollPeriodService");
(async () => {
    const c = await db.query(`INSERT INTO companies (company_name,company_code,email) VALUES ('P','PCO','p@e.test') RETURNING id`);
    const p = await PS.createPayrollPeriod({ company_id: c.rows[0].id, month: 7, year: 2026 });
    console.error("created:", p.success, p.data && p.data.id);
    const r = await PS.getDeletionPreview(p.data.id);
    console.error("preview success:", r.success);
    console.error(JSON.stringify(r.data, null, 1));
    process.exit(0);
})();
