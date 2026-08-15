
const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const compression = require("compression");
const { migrate } = require("./migrate");

// Load environment variables
dotenv.config();

// Import database connection
const { testConnection } = require("./config/database");

// Import middleware
const { errorHandler } = require("./utils/errorHandler");

// Initialize express app
const app = express();

// Port configuration
const PORT = process.env.PORT || 5000;
const NODE_ENV = process.env.NODE_ENV || "development";

// Middleware
// Security headers
app.use(helmet());

// server.js
require("./jobs/attendanceReminderJob");
require("./jobs/birthdayNotificationJob");

// CORS configuration
const corsOptions = {
    origin: process.env.ALLOWED_ORIGINS?.split(",") || "*",
    credentials: true,
    optionsSuccessStatus: 200,
};
app.use(cors(corsOptions));

// Body parser
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Compression
app.use(compression());

// Logging
if (NODE_ENV === "development") {
    app.use(morgan("dev"));
} else {
    app.use(morgan("combined"));
}

// Health check route
app.get("/health", (req, res) => {
    res.status(200).json({
        success: true,
        message: "Server is running",
        timestamp: new Date().toISOString(),
        environment: NODE_ENV,
    });
});

// Blocks every state-changing request made against a company that a Super Admin
// has disabled. Must be mounted BEFORE the route table so it covers all modules.
const { enforceCompanyActive } = require("./middleware/enforceCompanyActive");
app.use("/api", enforceCompanyActive);

// Records every state-changing request into activity_logs. Runs after the
// response is sent, so it never slows down or breaks a request.
const { activityLogger } = require("./middleware/activityLogger");
app.use("/api", activityLogger);

// Plan gating. Mounted per module below rather than globally, because which
// modules a plan includes is exactly what varies. See enums/features.js for
// the key list and docs/PRICING_AND_PLANS.md for the model.
const { requireFeature } = require("./middleware/enforceEntitlement");
const { Feature } = require("./enums/features");

//All Routes
const SuperAdminRoutes = require("./routes/superAdminRoute");
app.use("/api/super-admin", SuperAdminRoutes);

const UserRoutes = require("./routes/userRoute");
app.use("/api/users", UserRoutes);

const CompanyRoutes = require("./routes/companyRoute");
app.use("/api/companies", CompanyRoutes);

// Plan entitlements, the pricing page and coupon redemption. Never gated by a
// plan itself — a company whose plan has lapsed must still be able to reach the
// upgrade path.
const BillingRoutes = require("./routes/billingRoute");
app.use("/api/companies/:company_id/billing", BillingRoutes);

const UserCompanyRoutes = require("./routes/userCompanyRoute");
app.use("/api/user-companies", UserCompanyRoutes);

const OtpTypeRoutes = require("./routes/otpTypeRoute");
app.use("/api/otps", OtpTypeRoutes);

const BranchRoutes = require("./routes/branchRoute");
app.use("/api/companies/:company_id/branches", BranchRoutes);

const DepartmentRoutes = require("./routes/departmentRoute");
app.use("/api/companies/:company_id/branches/:branch_id/departments", DepartmentRoutes);

const OrgChartRoutes = require("./routes/orgChartRoute");
app.use("/api/companies/:company_id/org-chart", OrgChartRoutes);

const ShiftRoutes = require("./routes/shiftRoute");
app.use("/api/companies/:company_id/branches/:branch_id/shifts", ShiftRoutes);

const EmployeeRoutes = require("./routes/employeeRoute");
app.use("/api/companies/:company_id/employees", EmployeeRoutes);

const EmployeeDocumentRoutes = require("./routes/employeeDocumentRoute");
app.use("/api/companies/:company_id/employees/:employee_id/documents", EmployeeDocumentRoutes);

const EmployeeSalaryStructureRoutes = require("./routes/employeeSalaryStructureRoute");
app.use("/api/companies/:company_id/employees/:employee_id/salary-structures", EmployeeSalaryStructureRoutes);

const EmployeeBankAccountRoutes = require("./routes/employeeBankAccountRoute");
app.use("/api/companies/:company_id/bank-accounts", EmployeeBankAccountRoutes);

// Gold only. Gated on every method including reads: a plan without gratuity
// never produced a figure, so there is no history to strand.
const EmployeeGratuityRoutes = require("./routes/employeeGratuityRoute");
app.use(
    "/api/companies/:company_id/gratuity",
    requireFeature(Feature.GRATUITY_CALCULATE),
    EmployeeGratuityRoutes
);

const EmployeeSalaryStructureBulkRoutes = require("./routes/employeeSalaryStructureBulkRoute");
app.use("/api/companies/:company_id/salary-structures/bulk-upload", EmployeeSalaryStructureBulkRoutes);

const attendanceRoutes = require("./routes/attendanceRoute");
app.use("/api/companies/:company_id/attendance", attendanceRoutes);

const attendanceReportRoutes = require("./routes/attendanceReportRoute");
app.use("/api/companies/:company_id/attendance-reports", attendanceReportRoutes);

const holidayRoutes = require("./routes/holidayRoute");
app.use("/api/companies/:company_id/holidays", holidayRoutes);

const leaveTypeRoutes = require("./routes/leaveTypeRoute");
app.use("/api/companies/:company_id/leave-types", leaveTypeRoutes);

const leaveRequestRoutes = require("./routes/leaveRequestUserRoute");
app.use(
    "/api/companies/:company_id/branches/:branch_id/employees/:employee_id/leave-requests",
    leaveRequestRoutes
);

const leaveRequestAdminRoutes = require("./routes/leaveRequestAdminRoute");
app.use("/api/companies/:company_id", leaveRequestAdminRoutes);

// ─────────────────────────────────────────────
// LEAVE SALARY — Pro and above
// ─────────────────────────────────────────────
//
// The annual-leave bucket: monthly accrual, the accrued liability, advance
// leave salary and encashment. Gated with allowReads: true for the same reason
// as payroll — a company that lapses can still open the accrual ledger and the
// payouts it already recorded, it just cannot book or pay more. The two payout
// paths carry their own keys inside the router.
const leaveSalaryRoutes = require("./routes/leaveSalaryRoute");
app.use(
    "/api/companies/:company_id/leave-salary",
    requireFeature(Feature.LEAVE_SALARY, { allowReads: true }),
    leaveSalaryRoutes
);

// ─────────────────────────────────────────────
// OFFBOARDING — Pro and above
// ─────────────────────────────────────────────
//
// Resignation, termination and the final settlement. Gating sits inside the
// router, on the endpoints that raise a case or a settlement: a company must
// always be able to finish offboarding someone it has already started, even if
// its plan lapses mid-notice.
const employeeSeparationRoutes = require("./routes/employeeSeparationRoute");
app.use("/api/companies/:company_id/separations", employeeSeparationRoutes);


// ─────────────────────────────────────────────
// PAYROLL — Pro and above
// ─────────────────────────────────────────────
//
// Gated with allowReads: true. Writes (generate, adjust, approve, pay) require
// the feature; GETs stay open so a company that lapses from Pro can still open
// the payroll it already ran. Hiding historical payroll behind an expired plan
// reads as data loss, and finance records are the worst possible thing to make
// someone feel they have lost.
const requirePayroll = requireFeature(Feature.PAYROLL_GENERATE, { allowReads: true });

// The single continuous payroll flow (period → generate → adjust → review →
// approve → pay → payslips). The routers below it stay mounted for the
// per-record operations the wizard calls into.
const payrollRunRoutes = require("./routes/payrollRunRoute");
app.use("/api/companies/:company_id/payroll-runs", requirePayroll, payrollRunRoutes);

// Fabricates a month of attendance so payroll can be tested end to end.
// The router blocks itself in production — see routes/testDataSeedRoute.js
const testDataSeedRoutes = require("./routes/testDataSeedRoute");
app.use("/api/companies/:company_id/test-data", testDataSeedRoutes);

const payrollPeriodRoutes = require("./routes/payrollPeriodRoute");
app.use("/api/companies/:company_id/payroll-periods", requirePayroll, payrollPeriodRoutes);

const payrollRoutes = require("./routes/payrollRoute");
app.use("/api/companies/:company_id/payrolls", requirePayroll, payrollRoutes);

const payrollAdjustmentRoutes = require("./routes/payrollAdjustmentRoute");
app.use("/api/companies/:company_id/payroll-adjustments", requirePayroll, payrollAdjustmentRoutes);

// Payslips have their own key — a plan could sell payroll without PDF payslips.
const payslipRoutes = require("./routes/payslipRoute");
app.use(
    "/api/companies/:company_id/payslips",
    requireFeature(Feature.PAYSLIP_PDF, { allowReads: true }),
    payslipRoutes
);

const notificationRoutes = require("./routes/notificationRoute");
app.use("/api/companies/:company_id/notifications", notificationRoutes);

const payrollBreakdownRouter = require("./routes/payrollBreakdownRoute");
app.use("/api/companies/:company_id/payroll-breakdown", requirePayroll, payrollBreakdownRouter);

// Pro and above. Fully gated: logs keep accruing for everyone (the logger is
// mounted globally), a lower plan just cannot read them — so an upgrade later
// reveals the full history rather than starting from empty.
const activityLogRoutes = require("./routes/activityLogRoute");
app.use(
    "/api/companies/:company_id/activity-logs",
    requireFeature(Feature.ACTIVITY_LOG),
    activityLogRoutes
);

const dashboardRoutes = require("./routes/dashboardRoute");
app.use("/api/companies/:company_id/dashboard", dashboardRoutes);



// 404 handler
app.use("*", (req, res) => {
    res.status(404).json({
        success: false,
        message: `Route ${req.originalUrl} not found`,
        timestamp: new Date().toISOString(),
    });
});

// Global error handler (must be last)
app.use(errorHandler);

// Start server
const startServer = async () => {
    try {
        // Test database connection
        console.log("Testing database connection...");
        const dbConnected = await testConnection();

        if (!dbConnected) {
            console.error("✗ Failed to connect to database");
            process.exit(1);
        }

        // ✅ Run migrations before server starts
        console.log("Running migrations...");
        await migrate();

        // Start listening
        app.listen(PORT, () => {
            console.log("=".repeat(50));
            console.log(`🚀 Server is running on port ${PORT}`);
            console.log(`📝 Environment: ${NODE_ENV}`);
            console.log(`🌐 API Base URL: http://localhost:${PORT}/api`);
            console.log(`❤️  Health Check: http://localhost:${PORT}/health`);
            console.log("=".repeat(50));
        });
    } catch (error) {
        console.error("✗ Error starting server:", error);
        process.exit(1);
    }
};

// Handle unhandled promise rejections
process.on("unhandledRejection", (err) => {
    console.error("UNHANDLED REJECTION! 💥 Shutting down...");
    console.error(err.name, err.message);
    process.exit(1);
});

// Handle uncaught exceptions
process.on("uncaughtException", (err) => {
    console.error("UNCAUGHT EXCEPTION! 💥 Shutting down...");
    console.error(err.name, err.message);
    process.exit(1);
});

// Start the server
startServer();

module.exports = app;
