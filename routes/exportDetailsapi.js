const express = require("express");
const PDFDocument = require("pdfkit");
const ExcelJS = require("exceljs");
const db = require("../db");

const router = express.Router();

/*
  Mount exactly with:
  app.use("/api/export-details", exportDetailsRoutes);

  Endpoints:
    GET /api/export-details/health
    GET /api/export-details/auth-check
    GET /api/export-details/data?period=month&month=YYYY-MM
    GET /api/export-details/data?period=week&month=YYYY-MM&week=1..4
    GET /api/export-details?format=pdf&period=month&month=YYYY-MM
    GET /api/export-details?format=excel&period=month&month=YYYY-MM
    GET /api/export-details?format=text&period=month&month=YYYY-MM
*/

// ============================================================
// AUTHENTICATION
// ============================================================

function toUserId(value) {
    if (value === undefined || value === null || value === "") {
        return null;
    }

    const id = Number(value);

    return Number.isInteger(id) && id > 0 ? id : null;
}

function readUserId(value) {
    if (!value) return null;

    if (typeof value !== "object") {
        return toUserId(value);
    }

    return (
        toUserId(value.id) ||
        toUserId(value.userId) ||
        toUserId(value.user_id) ||
        null
    );
}

function getUserIdFromExistingAuth(req, res) {
    const candidates = [
        req.user,
        req.authUser,
        req.session && req.session.user,
        req.session && req.session.userId,
        req.session && req.session.user_id,
        res.locals && res.locals.user,
        res.locals && res.locals.userId,
        res.locals && res.locals.user_id,
        req.userId,
        req.user_id,
        req.authUserId,
        req.auth_user_id
    ];

    for (const candidate of candidates) {
        const id = readUserId(candidate);

        if (id) return id;
    }

    return null;
}

function getUserIdFromBearer(req) {
    const authorization = req.headers.authorization;

    if (!authorization) return null;

    const match = /^Bearer\s+(.+)$/i.exec(
        String(authorization).trim()
    );

    if (!match) return null;

    const token = match[1].trim();

    const numericId = toUserId(token);

    if (numericId) return numericId;

    if (!process.env.JWT_SECRET) return null;

    try {
        const jwt = require("jsonwebtoken");

        const payload = jwt.verify(
            token,
            process.env.JWT_SECRET
        );

        return readUserId(payload);
    } catch (error) {
        console.error(
            "Export JWT verification failed:",
            error.message
        );

        return null;
    }
}

function getUserIdFromHeaders(req) {
    const headers = req.headers || {};

    return (
        toUserId(headers["x-user-id"]) ||
        toUserId(headers["x-userid"]) ||
        toUserId(headers["x-auth-user-id"]) ||
        null
    );
}

function requireUser(req, res, next) {
    const userId =
        getUserIdFromExistingAuth(req, res) ||
        getUserIdFromBearer(req) ||
        getUserIdFromHeaders(req);

    if (!userId) {
        return res.status(401).json({
            success: false,
            code: "AUTH_USER_NOT_FOUND",
            message:
                "User authentication required. The logged-in user was not attached to this request."
        });
    }

    req.exportUserId = userId;

    next();
}

// ============================================================
// PERIOD HELPERS
// ============================================================

function cleanPeriod(value) {
    return value === "week" ? "week" : "month";
}

function isValidMonth(value) {
    return /^\d{4}-(0[1-9]|1[0-2])$/.test(value || "");
}

function getCurrentMonth() {
    const now = new Date();

    return [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, "0")
    ].join("-");
}

function getPeriod(req) {
    const period = cleanPeriod(req.query.period);
    const month = isValidMonth(req.query.month)
        ? req.query.month
        : getCurrentMonth();

    let week = null;

    if (period === "week") {
        const parsedWeek = Number(req.query.week);

        if (
            !Number.isInteger(parsedWeek) ||
            parsedWeek < 1 ||
            parsedWeek > 4
        ) {
            const error = new Error(
                "For weekly reports, week must be 1, 2, 3 or 4."
            );

            error.status = 400;
            throw error;
        }

        week = parsedWeek;
    }

    return {
        period,
        month,
        week
    };
}

function getDateRange(month, week) {
    const [year, monthNumber] = month
        .split("-")
        .map(Number);

    const firstDay = new Date(
        Date.UTC(year, monthNumber - 1, 1)
    );

    const lastDay = new Date(
        Date.UTC(year, monthNumber, 0)
    );

    if (!week) {
        return {
            start: toSqlDate(firstDay),
            end: toSqlDate(lastDay)
        };
    }

    const startDay = (week - 1) * 7 + 1;
    const endDay = Math.min(
        week * 7,
        lastDay.getUTCDate()
    );

    const start = new Date(
        Date.UTC(year, monthNumber - 1, startDay)
    );

    const end = new Date(
        Date.UTC(year, monthNumber - 1, endDay)
    );

    return {
        start: toSqlDate(start),
        end: toSqlDate(end)
    };
}

function toSqlDate(date) {
    return [
        date.getUTCFullYear(),
        String(date.getUTCMonth() + 1).padStart(2, "0"),
        String(date.getUTCDate()).padStart(2, "0")
    ].join("-");
}

function displayDate(value) {
    if (!value) return "-";

    const text = String(value).slice(0, 10);
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);

    if (!match) return "-";

    const months = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun",
        "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
    ];

    return `${match[3]} ${months[Number(match[2]) - 1]} ${match[1]}`;
}

function displayMonth(month) {
    const [year, monthNumber] = month.split("-").map(Number);

    const months = [
        "January", "February", "March", "April",
        "May", "June", "July", "August",
        "September", "October", "November", "December"
    ];

    return `${months[monthNumber - 1]} ${year}`;
}

// ============================================================
// VALUE / NUMBER HELPERS
// ============================================================

function numberValue(value) {
    const number = Number(value);

    return Number.isFinite(number) ? number : 0;
}

function formatAmount(value) {
    const number = numberValue(value);

    if (Number.isInteger(number)) {
        return String(number);
    }

    const formatted = number.toFixed(2);
    return formatted.replace(/\.?0+$/, '');
}

// For TXT and Excel - use ₹ symbol
function formatMoney(value) {
    const amount = formatAmount(value);
    if (amount.startsWith('-')) {
        return `-₹${amount.substring(1)}`;
    }
    return `₹${amount}`;
}

// For PDF - use "Rs." to avoid Unicode rendering issues
function formatMoneyPdf(value) {
    const amount = formatAmount(value);
    if (amount.startsWith('-')) {
        return `-Rs. ${amount.substring(1)}`;
    }
    return `Rs. ${amount}`;
}

function escapeText(value) {
    if (value === null || value === undefined) {
        return "-";
    }

    const text = String(value).trim();

    return text || "-";
}

function cleanFilePart(value) {
    return String(value)
        .replace(/[^a-z0-9_-]+/gi, "_")
        .replace(/^_+|_+$/g, "");
}

// ============================================================
// DATABASE HELPERS
// ============================================================

async function query(text, params) {
    return db.query(text, params);
}

// ============================================================
// DATA LOADING
// ============================================================

async function loadReportData(userId, periodInfo) {
    const { period, month, week } = periodInfo;
    const range = getDateRange(month, week);

    const [
        userResult,
        expensesResult,
        loansBorrowResult,
        emiResult,
        paymentsResult,
        businessWorkResult,
        overviewResult
    ] = await Promise.all([
        query(
            `
            SELECT
                id,
                full_name,
                profession,
                instagram,
                phone1,
                phone2,
                email1,
                email2,
                username,
                email_address,
                street,
                city,
                taluka,
                district,
                state,
                pincode,
                profile_image,
                created_at,
                updated_at
            FROM personal_users
            WHERE id = $1
            LIMIT 1
            `,
            [userId]
        ),

        query(
            `
            SELECT
                id,
                category,
                amount,
                expense_date,
                notes,
                created_at
            FROM personal_expenses
            WHERE user_id = $1
              AND expense_date BETWEEN $2::date AND $3::date
            ORDER BY expense_date ASC, id ASC
            `,
            [userId, range.start, range.end]
        ),

        query(
            `
            SELECT
                id,
                name,
                type,
                amount,
                emi,
                start_date,
                end_date,
                return_date,
                status,
                notes,
                created_at
            FROM personal_loans_borrow
            WHERE user_id = $1
              AND (
                    start_date BETWEEN $2::date AND $3::date
                    OR (
                        end_date IS NOT NULL
                        AND end_date BETWEEN $2::date AND $3::date
                    )
                    OR (
                        return_date IS NOT NULL
                        AND return_date BETWEEN $2::date AND $3::date
                    )
                    OR (
                        start_date <= $3::date
                        AND (
                            end_date IS NULL
                            OR end_date >= $2::date
                        )
                    )
                  )
            ORDER BY start_date ASC, id ASC
            `,
            [userId, range.start, range.end]
        ),

        query(
            `
            SELECT
                id,
                loan_id,
                amount,
                payment_date,
                payment_type,
                notes,
                created_at
            FROM personal_loan_emi_payments
            WHERE user_id = $1
              AND payment_date BETWEEN $2::date AND $3::date
            ORDER BY payment_date ASC, id ASC
            `,
            [userId, range.start, range.end]
        ),

        query(
            `
            SELECT
                id,
                person_name,
                amount,
                category,
                payment_date,
                status,
                received_at,
                notes,
                created_at,
                updated_at
            FROM personal_payments
            WHERE user_id = $1
              AND payment_date BETWEEN $2::date AND $3::date
            ORDER BY payment_date ASC, id ASC
            `,
            [userId, range.start, range.end]
        ),

        query(
            `
            SELECT
                id,
                name,
                type,
                status,
                amount,
                start_date,
                end_date,
                notes,
                created_at,
                updated_at
            FROM personal_business_work
            WHERE user_id = $1
              AND (
                    start_date BETWEEN $2::date AND $3::date
                    OR (
                        end_date IS NOT NULL
                        AND end_date BETWEEN $2::date AND $3::date
                    )
                    OR (
                        start_date <= $3::date
                        AND (
                            end_date IS NULL
                            OR end_date >= $2::date
                        )
                    )
                  )
            ORDER BY start_date ASC, id ASC
            `,
            [userId, range.start, range.end]
        ),

        query(
            `
            SELECT *
            FROM personal_overview
            WHERE user_id = $1
              AND month_start = $2::date
            ORDER BY id DESC
            LIMIT 1
            `,
            [
                userId,
                `${month}-01`
            ]
        )
    ]);

    if (!userResult.rows.length) {
        const error = new Error(
            "Logged-in user was not found in personal_users."
        );

        error.status = 404;
        throw error;
    }

    const user = userResult.rows[0];
    const expenses = expensesResult.rows;
    const loansBorrow = loansBorrowResult.rows;
    const emiPayments = emiResult.rows;
    const payments = paymentsResult.rows;
    const businessWork = businessWorkResult.rows;
    const overview = overviewResult.rows[0] || null;

    const expenseTotal = expenses.reduce(
        (sum, row) => sum + numberValue(row.amount),
        0
    );

    const emiTotal = emiPayments
        .filter((row) => row.payment_type === "EMI")
        .reduce(
            (sum, row) => sum + numberValue(row.amount),
            0
        );

    const loanRepaymentTotal = emiPayments
        .filter(
            (row) =>
                row.payment_type === "Loan Repayment"
        )
        .reduce(
            (sum, row) => sum + numberValue(row.amount),
            0
        );

    const borrowRepaymentTotal = emiPayments
        .filter(
            (row) =>
                row.payment_type === "Borrow Repayment"
        )
        .reduce(
            (sum, row) => sum + numberValue(row.amount),
            0
        );

    const receivedTotal = payments
        .filter((row) => row.status === "Received")
        .reduce(
            (sum, row) => sum + numberValue(row.amount),
            0
        );

    const pendingTotal = payments
        .filter((row) => row.status === "Pending")
        .reduce(
            (sum, row) => sum + numberValue(row.amount),
            0
        );

    const overdueTotal = payments
        .filter((row) => row.status === "Overdue")
        .reduce(
            (sum, row) => sum + numberValue(row.amount),
            0
        );

    const lostTotal = payments
        .filter((row) => row.status === "Lost")
        .reduce(
            (sum, row) => sum + numberValue(row.amount),
            0
        );

    const activeLoanTotal = loansBorrow
        .filter(
            (row) =>
                row.type === "Loan" &&
                row.status === "Active"
        )
        .reduce(
            (sum, row) => sum + numberValue(row.amount),
            0
        );

    const activeBorrowTotal = loansBorrow
        .filter(
            (row) =>
                row.type === "Borrow" &&
                row.status === "Active"
        )
        .reduce(
            (sum, row) => sum + numberValue(row.amount),
            0
        );

    const businessTotal = businessWork
        .filter((row) => row.type === "Business")
        .reduce(
            (sum, row) => sum + numberValue(row.amount),
            0
        );

    const workTotal = businessWork
        .filter((row) => row.type === "Work")
        .reduce(
            (sum, row) => sum + numberValue(row.amount),
            0
        );

    const outgoingTotal =
        expenseTotal +
        emiTotal +
        loanRepaymentTotal +
        borrowRepaymentTotal;

    const netResult =
        receivedTotal - outgoingTotal;

    const expenseCategories = {};

    for (const row of expenses) {
        const category =
            escapeText(row.category);

        expenseCategories[category] =
            (expenseCategories[category] || 0) +
            numberValue(row.amount);
    }

    const categoryRows = Object.entries(
        expenseCategories
    )
        .map(([category, amount]) => ({
            category,
            amount,
            share:
                expenseTotal > 0
                    ? (amount / expenseTotal) * 100
                    : 0
        }))
        .sort((a, b) => b.amount - a.amount);

    const overviewValues = {
        total_business:
            overview?.total_business ??
            businessWork.filter(
                (row) => row.type === "Business"
            ).length,

        total_works:
            overview?.total_works ??
            businessWork.filter(
                (row) => row.type === "Work"
            ).length,

        business_payment:
            overview?.business_payment ??
            payments
                .filter(
                    (row) => row.category === "Business"
                )
                .reduce(
                    (sum, row) =>
                        sum + numberValue(row.amount),
                    0
                ),

        work_payment:
            overview?.work_payment ??
            payments
                .filter(
                    (row) => row.category === "Work"
                )
                .reduce(
                    (sum, row) =>
                        sum + numberValue(row.amount),
                    0
                ),

        total_expenses:
            overview?.total_expenses ??
            expenseTotal,

        total_borrow:
            overview?.total_borrow ??
            loansBorrow
                .filter(
                    (row) => row.type === "Borrow"
                )
                .reduce(
                    (sum, row) =>
                        sum + numberValue(row.amount),
                    0
                ),

        total_loans:
            overview?.total_loans ??
            loansBorrow
                .filter(
                    (row) => row.type === "Loan"
                )
                .reduce(
                    (sum, row) =>
                        sum + numberValue(row.amount),
                    0
                ),

        month_start:
            overview?.month_start ||
            `${month}-01`
    };

    // Calculate Month-End Summary
    const totalIncome = receivedTotal;
    const totalExpenses = expenseTotal;
    const totalLoanPayments = loanRepaymentTotal;
    const totalBorrowPayments = borrowRepaymentTotal;
    const totalEMI = emiTotal;
    const totalPending = pendingTotal;
    const totalBusinessWorkPayment = businessTotal + workTotal;

    const totalOutgoingAll =
        totalExpenses +
        totalEMI +
        totalLoanPayments +
        totalBorrowPayments;

    const totalSavings = totalIncome - totalOutgoingAll;

    let financialStatus = "BREAK EVEN";
    let statusEmoji = "➖";

    if (totalSavings > 0) {
        financialStatus = "PROFIT";
        statusEmoji = "✅";
    } else if (totalSavings < 0) {
        financialStatus = "LOSS";
        statusEmoji = "❌";
    } else {
        financialStatus = "BREAK EVEN";
        statusEmoji = "➖";
    }

    const monthEndSummary = {
        total_income: totalIncome,
        total_expenses: totalExpenses,
        total_emi: totalEMI,
        total_loan_repayment: totalLoanPayments,
        total_borrow_repayment: totalBorrowPayments,
        total_business_work_payment: totalBusinessWorkPayment,
        total_pending: totalPending,
        total_outgoing: totalOutgoingAll,
        total_savings: totalSavings,
        status: financialStatus,
        status_emoji: statusEmoji,
        month: displayMonth(month),
        period: period,
        week: week
    };

    return {
        user,
        period: {
            type: period,
            month,
            week,
            start: range.start,
            end: range.end
        },
        expenses,
        expenseCategories: categoryRows,
        loansBorrow,
        emiPayments,
        payments,
        businessWork,
        overview: overviewValues,
        monthEndSummary,
        summary: {
            received: receivedTotal,
            expenses: expenseTotal,
            emi: emiTotal,
            loanRepayment: loanRepaymentTotal,
            borrowRepayment: borrowRepaymentTotal,
            totalOutgoing: outgoingTotal,
            netResult,
            pending: pendingTotal,
            overdue: overdueTotal,
            lost: lostTotal,
            activeLoan: activeLoanTotal,
            activeBorrow: activeBorrowTotal,
            businessTotal,
            workTotal
        }
    };
}

// ============================================================
// DATA ROUTE
// ============================================================

router.get(
    "/data",
    requireUser,
    async (req, res) => {
        try {
            const periodInfo = getPeriod(req);

            const data = await loadReportData(
                req.exportUserId,
                periodInfo
            );

            return res.json({
                success: true,
                data
            });
        } catch (error) {
            console.error(
                "GET export details data error:",
                error
            );

            return res.status(
                error.status || 500
            ).json({
                success: false,
                message:
                    error.message ||
                    "Failed to load export details."
            });
        }
    }
);

// ============================================================
// HEALTH / AUTH CHECK
// ============================================================

router.get(
    "/health",
    (req, res) => {
        res.json({
            success: true,
            service: "export-details",
            status: "ok"
        });
    }
);

router.get(
    "/auth-check",
    requireUser,
    (req, res) => {
        res.json({
            success: true,
            authenticated: true,
            userId: req.exportUserId
        });
    }
);

// ============================================================
// TXT EXPORT
// ============================================================

function buildTextReport(data) {
    const lines = [];

    const add = (line = "") => {
        lines.push(line);
    };

    add("PERSONAL FINANCIAL REPORT");
    add("");
    add(
        `Report: ${
            data.period.type === "week"
                ? `Week ${data.period.week}`
                : "Monthly"
        } — ${displayMonth(data.period.month)}`
    );
    add(`Name: ${escapeText(data.user.full_name)}`);
    add(
        `Profession: ${escapeText(data.user.profession)}`
    );
    add(
        `Username: ${escapeText(data.user.username)}`
    );
    add(
        `Email: ${escapeText(data.user.email_address)}`
    );
    add(
        `Period: ${displayDate(data.period.start)} to ${displayDate(data.period.end)}`
    );

    add("");
    add("FINANCIAL SUMMARY");
    add("");

    const summaryRows = [
        ["Received / Income", data.summary.received],
        ["Expenses", data.summary.expenses],
        ["EMI", data.summary.emi],
        ["Loan Repayment", data.summary.loanRepayment],
        ["Borrow Repayment", data.summary.borrowRepayment],
        ["Total Outgoing", data.summary.totalOutgoing],
        ["Net Result", data.summary.netResult],
        ["Pending", data.summary.pending],
        ["Overdue", data.summary.overdue],
        ["Lost", data.summary.lost],
        ["Active Loan", data.summary.activeLoan],
        ["Active Borrow", data.summary.activeBorrow],
        ["Business Total", data.summary.businessTotal],
        ["Work Total", data.summary.workTotal]
    ];

    for (const [label, amount] of summaryRows) {
        add(`${label}: ${formatMoney(amount)}`);
    }

    if (data.expenseCategories.length) {
        add("");
        add("EXPENSE CATEGORIES");
        add("");

        for (const row of data.expenseCategories) {
            add(`Category: ${row.category}`);
            add(
                `Amount: ${formatMoney(row.amount)}`
            );
            add(
                `Share: ${row.share.toFixed(1)}%`
            );
            add("");
        }
    }

    if (data.expenses.length) {
        add("EXPENSES");
        add("");

        for (const row of data.expenses) {
            add(
                `Category: ${escapeText(row.category)}`
            );
            add(
                `Amount: ${formatMoney(row.amount)}`
            );
            add(
                `Date: ${displayDate(row.expense_date)}`
            );
            add(
                `Notes: ${escapeText(row.notes)}`
            );
            add("");
        }
    }

    if (data.businessWork.length) {
        add("BUSINESS / WORK");
        add("");

        for (const row of data.businessWork) {
            add(`Type: ${escapeText(row.type)}`);
            add(`Name: ${escapeText(row.name)}`);
            add(
                `Amount: ${formatMoney(row.amount)}`
            );
            add(`Status: ${escapeText(row.status)}`);
            add(
                `Start Date: ${displayDate(row.start_date)}`
            );
            add(
                `End Date: ${displayDate(row.end_date)}`
            );
            add(`Notes: ${escapeText(row.notes)}`);
            add("");
        }
    }

    if (data.loansBorrow.length) {
        add("LOANS / BORROW");
        add("");

        for (const row of data.loansBorrow) {
            add(`Type: ${escapeText(row.type)}`);
            add(`Name: ${escapeText(row.name)}`);
            add(
                `Amount: ${formatMoney(row.amount)}`
            );
            add(`EMI: ${formatMoney(row.emi)}`);
            add(`Status: ${escapeText(row.status)}`);
            add(
                `Start Date: ${displayDate(row.start_date)}`
            );
            add(
                `End Date: ${displayDate(row.end_date)}`
            );
            add(
                `Return Date: ${displayDate(row.return_date)}`
            );
            add(`Notes: ${escapeText(row.notes)}`);
            add("");
        }
    }

    if (data.emiPayments.length) {
        add("EMI PAYMENTS");
        add("");

        for (const row of data.emiPayments) {
            const loan = data.loansBorrow.find(l => l.id === row.loan_id);
            const loanName = loan ? escapeText(loan.name) : "-";
            
            add(`Loan: ${loanName}`);
            add(
                `Payment Type: ${escapeText(row.payment_type)}`
            );
            add(
                `Amount: ${formatMoney(row.amount)}`
            );
            add(
                `Date: ${displayDate(row.payment_date)}`
            );
            add(`Notes: ${escapeText(row.notes)}`);
            add("");
        }
    }

    if (data.payments.length) {
        add("PAYMENTS");
        add("");

        for (const row of data.payments) {
            add(
                `Person: ${escapeText(row.person_name)}`
            );
            add(
                `Category: ${escapeText(row.category)}`
            );
            add(
                `Amount: ${formatMoney(row.amount)}`
            );
            add(
                `Date: ${displayDate(row.payment_date)}`
            );
            add(`Status: ${escapeText(row.status)}`);
            add(
                `Received At: ${
                    row.received_at
                        ? displayDate(row.received_at)
                        : "-"
                }`
            );
            add(`Notes: ${escapeText(row.notes)}`);
            add("");
        }
    }

    add("MONTHLY OVERVIEW");
    add("");

    const overviewLabels = [
        ["Total Business", data.overview.total_business],
        ["Total Works", data.overview.total_works],
        ["Business Payment", data.overview.business_payment],
        ["Work Payment", data.overview.work_payment],
        ["Total Expenses", data.overview.total_expenses],
        ["Total Borrow", data.overview.total_borrow],
        ["Total Loans", data.overview.total_loans]
    ];

    for (const [label, value] of overviewLabels) {
        if (
            typeof value === "number" ||
            /^\d+(\.\d+)?$/.test(String(value))
        ) {
            add(
                `${label}: ${formatMoney(value)}`
            );
        } else {
            add(
                `${label}: ${escapeText(value)}`
            );
        }
    }

    add(
        `Month Start: ${displayDate(data.overview.month_start)}`
    );

    // ============================================================
    // MONTH END SUMMARY
    // ============================================================
    add("");
    add("═══════════════════════════════════════════════════════════════");
    add("                   MONTH END SUMMARY");
    add("═══════════════════════════════════════════════════════════════");
    add("");

    const mes = data.monthEndSummary;
    add(`Month: ${mes.month}`);
    add("");
    add("INCOME & EXPENSES");
    add(`  Total Income (Received)        : ${formatMoney(mes.total_income)}`);
    add(`  Total Expenses                 : ${formatMoney(mes.total_expenses)}`);
    add(`  Total EMI Paid                 : ${formatMoney(mes.total_emi)}`);
    add(`  Total Loan Repayment           : ${formatMoney(mes.total_loan_repayment)}`);
    add(`  Total Borrow Repayment         : ${formatMoney(mes.total_borrow_repayment)}`);
    add(`  Business/Work Payment          : ${formatMoney(mes.total_business_work_payment)}`);
    add(`  Total Pending                  : ${formatMoney(mes.total_pending)}`);
    add("");
    add("CALCULATION");
    add(`  Total Outgoing                 : ${formatMoney(mes.total_outgoing)}`);
    add(`  Total Savings / (Loss)         : ${formatMoney(mes.total_savings)}`);
    add("");
    
    // Status with prominent display
    add("  ═══════════════════════════════════════════════════════════════");
    add(`         RESULT: ${mes.status} ${mes.status_emoji}`);
    add("  ═══════════════════════════════════════════════════════════════");
    add("");

    add("Generated automatically.");

    return lines.join("\n");
}

// ============================================================
// PDF HELPERS - BLACK & WHITE PROFESSIONAL
// ============================================================

function pdfText(value) {
    return escapeText(value);
}

function createPdfTable(doc, title, columns, rows, options = {}) {
    if (!rows || !rows.length) return;

    const pageWidth =
        doc.page.width -
        doc.page.margins.left -
        doc.page.margins.right;

    const columnWidths = columns.map(
        (column) =>
            pageWidth *
            (column.width || 1) /
            columns.reduce(
                (sum, item) =>
                    sum + (item.width || 1),
                0
            )
    );

    const rowHeight = 24;
    const headerHeight = 26;

    function ensureSpace(requiredHeight) {
        const availableSpace = 
            doc.page.height -
            doc.page.margins.bottom -
            40 -
            doc.y;

        if (availableSpace < requiredHeight) {
            doc.addPage();
            return true;
        }
        return false;
    }

    function drawRow(values, isHeader, continueFromPrevious = false) {
        const height = isHeader ? headerHeight : rowHeight;
        
        if (!continueFromPrevious) {
            ensureSpace(height + 10);
        }

        let x = doc.page.margins.left;
        const y = doc.y;

        if (isHeader) {
            doc
                .rect(
                    x,
                    y,
                    pageWidth,
                    height
                )
                .fill("#E8E8E8");
        }

        doc
            .font(
                isHeader
                    ? "Helvetica-Bold"
                    : "Helvetica"
            )
            .fontSize(isHeader ? 9.5 : 9)
            .fillColor("#000000");

        values.forEach(
            (value, index) => {
                const textValue = pdfText(value);
                
                const isNumeric = /^[\dRs.,\s-]+$/.test(textValue.replace(/Rs\./g, '').trim());
                
                doc.text(
                    textValue,
                    x + 6,
                    y + (isHeader ? 7 : 5),
                    {
                        width: columnWidths[index] - 12,
                        height: height - 10,
                        ellipsis: true,
                        lineBreak: false,
                        align: isNumeric ? 'right' : 'left'
                    }
                );

                x += columnWidths[index];
            }
        );

        doc
            .strokeColor("#000000")
            .lineWidth(isHeader ? 0.8 : 0.3)
            .moveTo(
                doc.page.margins.left,
                y + height
            )
            .lineTo(
                doc.page.margins.left +
                    pageWidth,
                y + height
            )
            .stroke();

        doc.y = y + height;
    }

    ensureSpace(50);
    doc
        .font("Helvetica-Bold")
        .fontSize(12)
        .fillColor("#000000")
        .text(title);
    
    const titleY = doc.y - 2;
    doc
        .strokeColor("#000000")
        .lineWidth(0.5)
        .moveTo(doc.page.margins.left, titleY)
        .lineTo(doc.page.margins.left + 80, titleY)
        .stroke();
    
    doc.moveDown(0.4);

    drawRow(
        columns.map((column) => column.label),
        true
    );

    for (const row of rows) {
        const values = columns.map((column) =>
            column.value(row)
        );
        
        if (doc.y + rowHeight > doc.page.height - doc.page.margins.bottom - 40) {
            doc.addPage();
            drawRow(
                columns.map((column) => column.label),
                true,
                true
            );
        }
        
        drawRow(values, false);
    }

    doc.moveDown(0.8);
}

function addPdfSummary(doc, data) {
    const rows = [
        ["Received / Income", formatMoneyPdf(data.summary.received)],
        ["Expenses", formatMoneyPdf(data.summary.expenses)],
        ["EMI", formatMoneyPdf(data.summary.emi)],
        ["Loan Repayment", formatMoneyPdf(data.summary.loanRepayment)],
        ["Borrow Repayment", formatMoneyPdf(data.summary.borrowRepayment)],
        ["Total Outgoing", formatMoneyPdf(data.summary.totalOutgoing)],
        ["Net Result", formatMoneyPdf(data.summary.netResult)],
        ["Pending", formatMoneyPdf(data.summary.pending)],
        ["Overdue", formatMoneyPdf(data.summary.overdue)],
        ["Lost", formatMoneyPdf(data.summary.lost)],
        ["Active Loan", formatMoneyPdf(data.summary.activeLoan)],
        ["Active Borrow", formatMoneyPdf(data.summary.activeBorrow)],
        ["Business Total", formatMoneyPdf(data.summary.businessTotal)],
        ["Work Total", formatMoneyPdf(data.summary.workTotal)]
    ];

    createPdfTable(
        doc,
        "FINANCIAL SUMMARY",
        [
            {
                label: "Metric",
                width: 2,
                value: (row) => row[0]
            },
            {
                label: "Amount",
                width: 1,
                value: (row) => row[1]
            }
        ],
        rows
    );
}

function addPdfMonthEndSummary(doc, data) {
    const mes = data.monthEndSummary;

    const rows = [
        ["Month", mes.month],
        ["", ""],
        ["INCOME & EXPENSES", ""],
        ["Total Income (Received)", formatMoneyPdf(mes.total_income)],
        ["Total Expenses", formatMoneyPdf(mes.total_expenses)],
        ["Total EMI Paid", formatMoneyPdf(mes.total_emi)],
        ["Total Loan Repayment", formatMoneyPdf(mes.total_loan_repayment)],
        ["Total Borrow Repayment", formatMoneyPdf(mes.total_borrow_repayment)],
        ["Business/Work Payment", formatMoneyPdf(mes.total_business_work_payment)],
        ["Total Pending", formatMoneyPdf(mes.total_pending)],
        ["", ""],
        ["CALCULATION", ""],
        ["Total Outgoing", formatMoneyPdf(mes.total_outgoing)],
        ["Total Savings / (Loss)", formatMoneyPdf(mes.total_savings)],
        ["", ""],
        ["═══════════ RESULT ═══════════", `${mes.status} ${mes.status_emoji}`]
    ];

    createPdfTable(
        doc,
        "MONTH END SUMMARY",
        [
            {
                label: "Field",
                width: 2,
                value: (row) => row[0]
            },
            {
                label: "Value",
                width: 2,
                value: (row) => row[1]
            }
        ],
        rows
    );
}

function addPdfUserDetails(doc, data) {
    doc
        .font("Helvetica-Bold")
        .fontSize(20)
        .fillColor("#000000")
        .text("PERSONAL FINANCIAL REPORT");

    doc.moveDown(0.4);
    
    doc
        .strokeColor("#000000")
        .lineWidth(0.5)
        .moveTo(doc.page.margins.left, doc.y - 2)
        .lineTo(doc.page.width - doc.page.margins.right, doc.y - 2)
        .stroke();

    doc.moveDown(0.6);

    doc
        .font("Helvetica")
        .fontSize(9.5)
        .fillColor("#000000");

    const reportName =
        data.period.type === "week"
            ? `Week ${data.period.week} — ${displayMonth(data.period.month)}`
            : `Monthly — ${displayMonth(data.period.month)}`;

    const lines = [
        `Report: ${reportName}`,
        `Name: ${escapeText(data.user.full_name)}`,
        `Profession: ${escapeText(data.user.profession)}`,
        `Username: ${escapeText(data.user.username)}`,
        `Email: ${escapeText(data.user.email_address)}`,
        `Period: ${displayDate(data.period.start)} to ${displayDate(data.period.end)}`
    ];

    for (const line of lines) {
        doc.text(line);
    }

    doc.moveDown(1);
}

function buildPdf(data) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({
            size: "A4",
            margin: 42,
            bufferPages: true,
            info: {
                Title: "Personal Financial Report",
                Author: data.user.full_name || "Personal Financial Report"
            }
        });

        const chunks = [];

        doc.on("data", (chunk) => {
            chunks.push(chunk);
        });

        doc.on("error", reject);

        doc.on("end", () => {
            const pageRange = doc.bufferedPageRange();

            for (let index = 0; index < pageRange.count; index += 1) {
                doc.switchToPage(pageRange.start + index);

                const footerY = doc.page.height - 30;

                doc
                    .strokeColor("#000000")
                    .lineWidth(0.5)
                    .moveTo(doc.page.margins.left, footerY - 8)
                    .lineTo(doc.page.width - doc.page.margins.right, footerY - 8)
                    .stroke();

                doc
                    .font("Helvetica")
                    .fontSize(8)
                    .fillColor("#000000")
                    .text(
                        `Page ${index + 1} of ${pageRange.count}`,
                        doc.page.margins.left,
                        footerY,
                        {
                            width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
                            align: "center",
                            lineBreak: false
                        }
                    );
            }

            resolve(Buffer.concat(chunks));
        });

        addPdfUserDetails(doc, data);
        addPdfSummary(doc, data);

        if (data.expenseCategories && data.expenseCategories.length) {
            createPdfTable(
                doc,
                "EXPENSE CATEGORIES",
                [
                    {
                        label: "Category",
                        width: 2,
                        value: (row) => row.category
                    },
                    {
                        label: "Amount",
                        width: 1,
                        value: (row) => formatMoneyPdf(row.amount)
                    },
                    {
                        label: "Share",
                        width: 1,
                        value: (row) => `${row.share.toFixed(1)}%`
                    }
                ],
                data.expenseCategories
            );
        }

        if (data.expenses && data.expenses.length) {
            createPdfTable(
                doc,
                "EXPENSES",
                [
                    {
                        label: "Category",
                        width: 1.4,
                        value: (row) => row.category
                    },
                    {
                        label: "Amount",
                        width: 1,
                        value: (row) => formatMoneyPdf(row.amount)
                    },
                    {
                        label: "Date",
                        width: 1.2,
                        value: (row) => displayDate(row.expense_date)
                    },
                    {
                        label: "Notes",
                        width: 2,
                        value: (row) => escapeText(row.notes)
                    }
                ],
                data.expenses
            );
        }

        if (data.businessWork && data.businessWork.length) {
            createPdfTable(
                doc,
                "BUSINESS / WORK",
                [
                    {
                        label: "Type",
                        width: 0.8,
                        value: (row) => row.type
                    },
                    {
                        label: "Name",
                        width: 1.5,
                        value: (row) => row.name
                    },
                    {
                        label: "Amount",
                        width: 1,
                        value: (row) => formatMoneyPdf(row.amount)
                    },
                    {
                        label: "Status",
                        width: 1,
                        value: (row) => row.status
                    },
                    {
                        label: "Start Date",
                        width: 1.2,
                        value: (row) => displayDate(row.start_date)
                    },
                    {
                        label: "End Date",
                        width: 1.2,
                        value: (row) => displayDate(row.end_date)
                    }
                ],
                data.businessWork
            );
        }

        if (data.loansBorrow && data.loansBorrow.length) {
            createPdfTable(
                doc,
                "LOANS / BORROW",
                [
                    {
                        label: "Type",
                        width: 0.8,
                        value: (row) => row.type
                    },
                    {
                        label: "Name",
                        width: 1.5,
                        value: (row) => row.name
                    },
                    {
                        label: "Amount",
                        width: 1,
                        value: (row) => formatMoneyPdf(row.amount)
                    },
                    {
                        label: "EMI",
                        width: 0.8,
                        value: (row) => formatMoneyPdf(row.emi)
                    },
                    {
                        label: "Status",
                        width: 1,
                        value: (row) => row.status
                    },
                    {
                        label: "Start Date",
                        width: 1.2,
                        value: (row) => displayDate(row.start_date)
                    },
                    {
                        label: "End Date",
                        width: 1.2,
                        value: (row) => displayDate(row.end_date)
                    },
                    {
                        label: "Return Date",
                        width: 1.2,
                        value: (row) => displayDate(row.return_date)
                    }
                ],
                data.loansBorrow
            );
        }

        if (data.emiPayments && data.emiPayments.length) {
            const emiRows = data.emiPayments.map(row => {
                const loan = data.loansBorrow.find(l => l.id === row.loan_id);
                return {
                    ...row,
                    loanName: loan ? escapeText(loan.name) : "-"
                };
            });

            createPdfTable(
                doc,
                "EMI PAYMENTS",
                [
                    {
                        label: "Loan",
                        width: 1.5,
                        value: (row) => row.loanName
                    },
                    {
                        label: "Payment Type",
                        width: 1.5,
                        value: (row) => row.payment_type
                    },
                    {
                        label: "Amount",
                        width: 1,
                        value: (row) => formatMoneyPdf(row.amount)
                    },
                    {
                        label: "Date",
                        width: 1.2,
                        value: (row) => displayDate(row.payment_date)
                    },
                    {
                        label: "Notes",
                        width: 2,
                        value: (row) => escapeText(row.notes)
                    }
                ],
                emiRows
            );
        }

        if (data.payments && data.payments.length) {
            createPdfTable(
                doc,
                "PAYMENTS",
                [
                    {
                        label: "Person",
                        width: 1.5,
                        value: (row) => row.person_name
                    },
                    {
                        label: "Category",
                        width: 1,
                        value: (row) => row.category
                    },
                    {
                        label: "Amount",
                        width: 1,
                        value: (row) => formatMoneyPdf(row.amount)
                    },
                    {
                        label: "Date",
                        width: 1.2,
                        value: (row) => displayDate(row.payment_date)
                    },
                    {
                        label: "Status",
                        width: 1.2,
                        value: (row) => row.status
                    },
                    {
                        label: "Received At",
                        width: 1.2,
                        value: (row) => row.received_at ? displayDate(row.received_at) : "-"
                    },
                    {
                        label: "Notes",
                        width: 1.8,
                        value: (row) => escapeText(row.notes)
                    }
                ],
                data.payments
            );
        }

        const overviewRows = [
            ["Total Business", String(data.overview.total_business)],
            ["Total Works", String(data.overview.total_works)],
            ["Business Payment", formatMoneyPdf(data.overview.business_payment)],
            ["Work Payment", formatMoneyPdf(data.overview.work_payment)],
            ["Total Expenses", formatMoneyPdf(data.overview.total_expenses)],
            ["Total Borrow", formatMoneyPdf(data.overview.total_borrow)],
            ["Total Loans", formatMoneyPdf(data.overview.total_loans)],
            ["Month Start", displayDate(data.overview.month_start)]
        ];

        createPdfTable(
            doc,
            "MONTHLY OVERVIEW",
            [
                {
                    label: "Field",
                    width: 2,
                    value: (row) => row[0]
                },
                {
                    label: "Value",
                    width: 2,
                    value: (row) => row[1]
                }
            ],
            overviewRows
        );

        // Month End Summary - Professional with status
        addPdfMonthEndSummary(doc, data);

        doc.end();
    });
}

// ============================================================
// EXCEL EXPORT
// ============================================================

function addExcelSheet(
    workbook,
    name,
    columns,
    rows
) {
    if (!rows || !rows.length) return;

    const sheet =
        workbook.addWorksheet(name);

    sheet.columns = columns.map(
        (column) => ({
            header: column.header,
            key: column.key,
            width: column.width || 18
        })
    );

    for (const row of rows) {
        sheet.addRow(row);
    }

    const headerRow = sheet.getRow(1);
    headerRow.font = {
        bold: true,
        color: {
            argb: "FFFFFFFF"
        },
        size: 11
    };
    headerRow.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: {
            argb: "FF4F46E5"
        }
    };
    headerRow.alignment = {
        vertical: "middle",
        horizontal: "left"
    };
    headerRow.height = 28;

    sheet.views = [
        {
            state: "frozen",
            ySplit: 1
        }
    ];

    const lastColumn = String.fromCharCode(64 + Math.min(columns.length, 26));
    sheet.autoFilter = {
        from: "A1",
        to: `${lastColumn}1`
    };

    sheet.eachRow({ includeEmpty: false }, function(row, rowNumber) {
        if (rowNumber === 1) return;
        
        row.alignment = {
            vertical: "top",
            wrapText: true
        };
    });
}

async function buildExcel(data) {
    const workbook =
        new ExcelJS.Workbook();

    workbook.creator =
        data.user.full_name ||
        "Personal Financial Report";

    workbook.created =
        new Date();

    // Summary Sheet
    const summaryRows = [
        {
            metric: "Received / Income",
            amount: data.summary.received
        },
        {
            metric: "Expenses",
            amount: data.summary.expenses
        },
        {
            metric: "EMI",
            amount: data.summary.emi
        },
        {
            metric: "Loan Repayment",
            amount:
                data.summary.loanRepayment
        },
        {
            metric: "Borrow Repayment",
            amount:
                data.summary.borrowRepayment
        },
        {
            metric: "Total Outgoing",
            amount:
                data.summary.totalOutgoing
        },
        {
            metric: "Net Result",
            amount:
                data.summary.netResult
        },
        {
            metric: "Pending",
            amount: data.summary.pending
        },
        {
            metric: "Overdue",
            amount: data.summary.overdue
        },
        {
            metric: "Lost",
            amount: data.summary.lost
        },
        {
            metric: "Active Loan",
            amount: data.summary.activeLoan
        },
        {
            metric: "Active Borrow",
            amount: data.summary.activeBorrow
        },
        {
            metric: "Business Total",
            amount:
                data.summary.businessTotal
        },
        {
            metric: "Work Total",
            amount:
                data.summary.workTotal
        }
    ];

    addExcelSheet(
        workbook,
        "Summary",
        [
            {
                header: "Metric",
                key: "metric",
                width: 28
            },
            {
                header: "Amount",
                key: "amount",
                width: 18
            }
        ],
        summaryRows
    );

    // Expenses Sheet
    addExcelSheet(
        workbook,
        "Expenses",
        [
            {
                header: "Category",
                key: "category",
                width: 24
            },
            {
                header: "Amount",
                key: "amount",
                width: 18
            },
            {
                header: "Date",
                key: "date",
                width: 16
            },
            {
                header: "Notes",
                key: "notes",
                width: 40
            }
        ],
        data.expenses.map((row) => ({
            category: row.category,
            amount: numberValue(row.amount),
            date: displayDate(row.expense_date),
            notes: escapeText(row.notes)
        }))
    );

    // Loans Borrow Sheet
    addExcelSheet(
        workbook,
        "Loans Borrow",
        [
            {
                header: "Type",
                key: "type",
                width: 14
            },
            {
                header: "Name",
                key: "name",
                width: 22
            },
            {
                header: "Amount",
                key: "amount",
                width: 18
            },
            {
                header: "EMI",
                key: "emi",
                width: 18
            },
            {
                header: "Status",
                key: "status",
                width: 16
            },
            {
                header: "Start Date",
                key: "startDate",
                width: 16
            },
            {
                header: "End Date",
                key: "endDate",
                width: 16
            },
            {
                header: "Return Date",
                key: "returnDate",
                width: 16
            },
            {
                header: "Notes",
                key: "notes",
                width: 40
            }
        ],
        data.loansBorrow.map((row) => ({
            type: row.type,
            name: row.name,
            amount: numberValue(row.amount),
            emi: numberValue(row.emi),
            status: row.status,
            startDate: displayDate(row.start_date),
            endDate: displayDate(row.end_date),
            returnDate: displayDate(row.return_date),
            notes: escapeText(row.notes)
        }))
    );

    // EMI Payments Sheet
    addExcelSheet(
        workbook,
        "EMI Payments",
        [
            {
                header: "Loan",
                key: "loan",
                width: 24
            },
            {
                header: "Payment Type",
                key: "paymentType",
                width: 20
            },
            {
                header: "Amount",
                key: "amount",
                width: 18
            },
            {
                header: "Date",
                key: "date",
                width: 16
            },
            {
                header: "Notes",
                key: "notes",
                width: 40
            }
        ],
        data.emiPayments.map((row) => {
            const loan = data.loansBorrow.find(l => l.id === row.loan_id);
            return {
                loan: loan ? escapeText(loan.name) : "-",
                paymentType: row.payment_type,
                amount: numberValue(row.amount),
                date: displayDate(row.payment_date),
                notes: escapeText(row.notes)
            };
        })
    );

    // Payments Sheet
    addExcelSheet(
        workbook,
        "Payments",
        [
            {
                header: "Person",
                key: "person",
                width: 24
            },
            {
                header: "Category",
                key: "category",
                width: 16
            },
            {
                header: "Amount",
                key: "amount",
                width: 18
            },
            {
                header: "Date",
                key: "date",
                width: 16
            },
            {
                header: "Status",
                key: "status",
                width: 16
            },
            {
                header: "Received At",
                key: "receivedAt",
                width: 18
            },
            {
                header: "Notes",
                key: "notes",
                width: 40
            }
        ],
        data.payments.map((row) => ({
            person: row.person_name,
            category: row.category,
            amount: numberValue(row.amount),
            date: displayDate(row.payment_date),
            status: row.status,
            receivedAt: row.received_at
                ? displayDate(row.received_at)
                : "-",
            notes: escapeText(row.notes)
        }))
    );

    // Business Work Sheet
    addExcelSheet(
        workbook,
        "Business Work",
        [
            {
                header: "Type",
                key: "type",
                width: 14
            },
            {
                header: "Name",
                key: "name",
                width: 24
            },
            {
                header: "Status",
                key: "status",
                width: 16
            },
            {
                header: "Amount",
                key: "amount",
                width: 18
            },
            {
                header: "Start Date",
                key: "startDate",
                width: 16
            },
            {
                header: "End Date",
                key: "endDate",
                width: 16
            },
            {
                header: "Notes",
                key: "notes",
                width: 40
            }
        ],
        data.businessWork.map((row) => ({
            type: row.type,
            name: row.name,
            status: row.status,
            amount: numberValue(row.amount),
            startDate: displayDate(row.start_date),
            endDate: displayDate(row.end_date),
            notes: escapeText(row.notes)
        }))
    );

    // Overview Sheet
    addExcelSheet(
        workbook,
        "Overview",
        [
            {
                header: "Field",
                key: "field",
                width: 28
            },
            {
                header: "Value",
                key: "value",
                width: 20
            }
        ],
        [
            {
                field: "Total Business",
                value:
                    numberValue(
                        data.overview.total_business
                    )
            },
            {
                field: "Total Works",
                value:
                    numberValue(
                        data.overview.total_works
                    )
            },
            {
                field: "Business Payment",
                value:
                    numberValue(
                        data.overview.business_payment
                    )
            },
            {
                field: "Work Payment",
                value:
                    numberValue(
                        data.overview.work_payment
                    )
            },
            {
                field: "Total Expenses",
                value:
                    numberValue(
                        data.overview.total_expenses
                    )
            },
            {
                field: "Total Borrow",
                value:
                    numberValue(
                        data.overview.total_borrow
                    )
            },
            {
                field: "Total Loans",
                value:
                    numberValue(
                        data.overview.total_loans
                    )
            },
            {
                field: "Month Start",
                value:
                    displayDate(
                        data.overview.month_start
                    )
            }
        ]
    );

    // ============================================================
    // MONTH END SUMMARY SHEET
    // ============================================================
    const mes = data.monthEndSummary;
    const monthEndRows = [
        { field: "Month", value: mes.month },
        { field: "", value: "" },
        { field: "INCOME & EXPENSES", value: "" },
        { field: "Total Income (Received)", value: mes.total_income },
        { field: "Total Expenses", value: mes.total_expenses },
        { field: "Total EMI Paid", value: mes.total_emi },
        { field: "Total Loan Repayment", value: mes.total_loan_repayment },
        { field: "Total Borrow Repayment", value: mes.total_borrow_repayment },
        { field: "Business/Work Payment", value: mes.total_business_work_payment },
        { field: "Total Pending", value: mes.total_pending },
        { field: "", value: "" },
        { field: "CALCULATION", value: "" },
        { field: "Total Outgoing", value: mes.total_outgoing },
        { field: "Total Savings / (Loss)", value: mes.total_savings },
        { field: "", value: "" },
        { field: "RESULT", value: `${mes.status} ${mes.status_emoji}` }
    ];

    addExcelSheet(
        workbook,
        "Month End Summary",
        [
            {
                header: "Field",
                key: "field",
                width: 30
            },
            {
                header: "Value",
                key: "value",
                width: 25
            }
        ],
        monthEndRows
    );

    // Apply number formatting to all worksheets
    for (const worksheet of workbook.worksheets) {
        worksheet.eachRow({ includeEmpty: false }, function(row, rowNumber) {
            if (rowNumber === 1) return;
            
            row.eachCell(function(cell) {
                if (typeof cell.value === "number") {
                    cell.numFmt = "#,##0.##";
                }
            });
        });

        worksheet.columns.forEach(function(column) {
            let maxLength = column.header.length;
            column.eachCell({ includeEmpty: false }, function(cell) {
                const cellValue = cell.value ? String(cell.value).length : 0;
                maxLength = Math.max(maxLength, cellValue);
            });
            column.width = Math.min(Math.max(maxLength + 4, 12), 60);
        });
    }

    return workbook.xlsx.writeBuffer();
}

// ============================================================
// EXPORT ROUTE
// ============================================================

router.get(
    "/",
    requireUser,
    async (req, res) => {
        try {
            const format =
                String(
                    req.query.format || "pdf"
                ).toLowerCase();

            if (
                ![
                    "pdf",
                    "excel",
                    "xlsx",
                    "text",
                    "txt"
                ].includes(format)
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Invalid format. Use pdf, excel or text."
                });
            }

            const periodInfo =
                getPeriod(req);

            const data =
                await loadReportData(
                    req.exportUserId,
                    periodInfo
                );

            const hasData = 
                data.expenses.length > 0 ||
                data.loansBorrow.length > 0 ||
                data.emiPayments.length > 0 ||
                data.payments.length > 0 ||
                data.businessWork.length > 0;

            if (!hasData) {
                return res.status(404).json({
                    success: false,
                    message: "No financial details available for the selected period."
                });
            }

            const monthName =
                cleanFilePart(
                    displayMonth(
                        data.period.month
                    )
                );

            const weekPart =
                data.period.type === "week"
                    ? `_Week_${data.period.week}`
                    : "";

            const baseName =
                `Personal_Financial_Report_${monthName}${weekPart}`;

            if (
                format === "text" ||
                format === "txt"
            ) {
                const text =
                    buildTextReport(data);

                const filename =
                    `${baseName}.txt`;

                res.status(200);
                res.setHeader(
                    "Content-Type",
                    "text/plain; charset=utf-8"
                );
                res.setHeader(
                    "Content-Disposition",
                    `attachment; filename="${filename}"`
                );

                return res.send(
                    Buffer.from(
                        text,
                        "utf8"
                    )
                );
            }

            if (
                format === "excel" ||
                format === "xlsx"
            ) {
                const buffer =
                    await buildExcel(data);

                const filename =
                    `${baseName}.xlsx`;

                res.status(200);
                res.setHeader(
                    "Content-Type",
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                );
                res.setHeader(
                    "Content-Disposition",
                    `attachment; filename="${filename}"`
                );

                return res.send(
                    Buffer.from(buffer)
                );
            }

            const pdfBuffer =
                await buildPdf(data);

            const filename =
                `${baseName}.pdf`;

            res.status(200);
            res.setHeader(
                "Content-Type",
                "application/pdf"
            );
            res.setHeader(
                "Content-Disposition",
                `attachment; filename="${filename}"`
            );

            return res.send(pdfBuffer);
        } catch (error) {
            console.error(
                "EXPORT DETAILS ERROR:",
                error
            );

            if (error.status === 404) {
                return res.status(404).json({
                    success: false,
                    message: error.message
                });
            }

            return res.status(
                error.status || 500
            ).json({
                success: false,
                message:
                    error.message ||
                    "Failed to export financial details."
            });
        }
    }
);

// ============================================================
// MODULE EXPORT
// ============================================================

module.exports = router;