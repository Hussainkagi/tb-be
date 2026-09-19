const PDFDocument = require("pdfkit");

// ─────────────────────────────────────────────────────────────────────────────
// Renders a payslip as a PDF, on demand.
//
// There is no stored payslip PDF anywhere in this system — `payslips.pdf_url`
// is only ever set by an admin manually (PATCH /:id/pdf-url) and nothing else
// writes it. The web admin app doesn't generate one either; it renders an HTML
// view and lets the browser's own "Print to PDF" handle it. Mobile has no
// equivalent, so this builds the same breakdown as a real PDF, from the exact
// fields already computed for the mobile detail screen (see
// service/payslipService.js:getMyPayslipById / models/payslipModel.js:findById).
//
// Returned document is itself a readable stream — callers `.pipe(res)` it
// directly rather than buffering the whole file in memory.
// ─────────────────────────────────────────────────────────────────────────────

const money = (value, currency) => {
    const n = Number(value ?? 0);
    const amount = (Number.isFinite(n) ? n : 0).toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
    return currency ? `${currency} ${amount}` : amount;
};

const dateOnly = (value) => (value ? String(value).slice(0, 10) : "");

/**
 * @param {object} payslip   The enriched record from PayslipModel.findById
 *                           (carries payroll figures, period and employee
 *                           fields already joined in) plus its `adjustments`.
 * @param {object} [company] { company_name, currency } — used for the header.
 */
function buildPayslipPdf(payslip, company = {}) {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const currency = company.currency || "";
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;

    const row = (label, value) => {
        const y = doc.y;
        doc.fontSize(10).fillColor("#374151").text(label, left, y, { width: (right - left) * 0.6 });
        doc.fontSize(10).fillColor("#111827").text(String(value), left, y, { width: right - left, align: "right" });
        doc.moveDown(0.6);
    };

    const section = (title, rows) => {
        doc.moveDown(0.4);
        doc.fontSize(11).fillColor("#111827").font("Helvetica-Bold").text(title.toUpperCase(), left, doc.y, {
            characterSpacing: 0.5,
        });
        doc.font("Helvetica");
        doc.moveTo(left, doc.y + 2).lineTo(right, doc.y + 2).strokeColor("#e5e7eb").stroke();
        doc.moveDown(0.6);
        rows.forEach(([label, value]) => row(label, value));
    };

    // ── Header ──────────────────────────────────────────────────────────────
    doc.fontSize(18).fillColor("#111827").font("Helvetica-Bold").text(company.company_name || "Payslip");
    doc.fontSize(10).fillColor("#6b7280").font("Helvetica").text("Payslip");
    doc.moveDown(1);

    const employeeName = `${payslip.employee_first_name ?? ""} ${payslip.employee_last_name ?? ""}`.trim();
    if (employeeName) doc.fontSize(12).fillColor("#111827").font("Helvetica-Bold").text(employeeName);
    doc.font("Helvetica").fontSize(10).fillColor("#374151");
    if (payslip.employee_code) doc.text(`Employee code: ${payslip.employee_code}`);
    doc.text(`Payslip number: ${payslip.payslip_number}`);
    if (payslip.period_name) doc.text(`Period: ${payslip.period_name}`);
    if (payslip.period_start_date || payslip.period_end_date) {
        // A plain hyphen, not an arrow glyph — pdfkit's standard Helvetica font
        // only covers WinAnsiEncoding, which has no U+2192.
        doc.text(`${dateOnly(payslip.period_start_date)} - ${dateOnly(payslip.period_end_date)}`);
    }
    doc.moveDown(1);

    // ── Net pay ─────────────────────────────────────────────────────────────
    // .rect().fill() paints in place and does not move doc.y, so the band's
    // top has to be captured BEFORE drawing it, then the cursor advanced
    // manually once the band and its text are placed.
    const bandTop = doc.y;
    doc.rect(left, bandTop, right - left, 60).fill("#111827");
    doc.fillColor("#d1d5db").fontSize(10).font("Helvetica").text("NET PAY", left + 16, bandTop + 12);
    doc.fillColor("#ffffff").fontSize(22).font("Helvetica-Bold").text(money(payslip.net_salary, currency), left + 16, bandTop + 26);
    doc.y = bandTop + 60 + 16;
    doc.font("Helvetica");

    // ── Breakdown ───────────────────────────────────────────────────────────
    section("Earnings", [
        ["Gross salary", money(payslip.gross_salary, currency)],
        ["Actual salary", money(payslip.actual_salary, currency)],
        [
            `Overtime${payslip.overtime_hours ? ` (${payslip.overtime_hours} h)` : ""}`,
            money(payslip.overtime_amount, currency),
        ],
        ["Bonus", money(payslip.bonus_amount, currency)],
    ]);

    section("Deductions", [
        ["Base deduction", money(payslip.base_deduction_amount, currency)],
        ["Other deductions", money(payslip.deduction_amount, currency)],
        ["Tax", money(payslip.tax_amount, currency)],
    ]);

    if (Array.isArray(payslip.adjustments) && payslip.adjustments.length > 0) {
        section(
            "Adjustments",
            payslip.adjustments.map((a) => [a.title || a.adjustment_type, money(a.amount, currency)])
        );
    }

    section("Attendance in this period", [
        ["Working days", payslip.total_working_days ?? "—"],
        ["Present", payslip.total_present_days ?? "—"],
        ["Absent", payslip.total_absent_days ?? "—"],
        ["Paid leave", payslip.total_paid_leave_days ?? "—"],
        ["Unpaid leave", payslip.total_unpaid_leave_days ?? "—"],
        ["Holidays", payslip.total_holidays ?? "—"],
        ["Payable days", payslip.payable_days ?? "—"],
    ]);

    doc.moveDown(1.5);
    doc.fontSize(8).fillColor("#9ca3af").text(
        `Generated ${new Date().toLocaleString("en-US")} — this PDF is produced on demand from the payslip record.`,
        left,
        doc.y,
        { width: right - left }
    );

    doc.end();
    return doc;
}

module.exports = { buildPayslipPdf };
