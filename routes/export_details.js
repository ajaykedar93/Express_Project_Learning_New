const express = require("express");
const jwt = require("jsonwebtoken");
const router = express.Router();
const db = require("../db.js");

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(" ")[1];

    if (!token) {
        return res.status(401).json({ error: "Access denied. No token provided." });
    }

    jwt.verify(
        token,
        process.env.JWT_SECRET || "your_secret_key",
        (err, user) => {
            if (err) {
                return res.status(403).json({ error: "Invalid or expired token." });
            }
            req.user = user;
            next();
        }
    );
};

const parseMonth = (value) => {
    if (!value) {
        const now = new Date();
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    }

    if (!/^\d{4}-\d{2}$/.test(value)) {
        throw new Error("Invalid month. Use YYYY-MM.");
    }

    const [year, month] = value.split("-").map(Number);

    if (month < 1 || month > 12) {
        throw new Error("Invalid month.");
    }

    return `${year}-${String(month).padStart(2, "0")}-01`;
};

const getMonthEnd = (monthStart) => {
    const d = new Date(`${monthStart}T00:00:00`);
    d.setMonth(d.getMonth() + 1);
    d.setDate(0);

    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const formatMonthName = (monthStart) =>
    new Date(`${monthStart}T00:00:00`).toLocaleDateString("en-IN", {
        month: "long",
        year: "numeric",
    });

const numberValue = (value) => Number(value) || 0;

router.get("/", authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const monthStart = parseMonth(req.query.month);
        const monthEnd = getMonthEnd(monthStart);

        const [
            overviewResult,
            expenseSummaryResult,
            expenseCategoriesResult,
            borrowResult,
            loanResult,
            emiResult,
        ] = await Promise.all([
            db.query(
                `
                SELECT
                    COALESCE(work_payment, 0) AS work_payment,
                    COALESCE(business_payment, 0) AS business_payment,
                    COALESCE(total_work, 0) AS total_work,
                    COALESCE(total_business, 0) AS total_business
                FROM personal_overview
                WHERE user_id = $1
                  AND month_start = $2::DATE
                LIMIT 1
                `,
                [userId, monthStart]
            ),

            db.query(
                `
                SELECT
                    COALESCE(SUM(amount), 0) AS total_expenses,
                    COUNT(*) AS expense_count
                FROM personal_expenses
                WHERE user_id = $1
                  AND expense_date >= $2::DATE
                  AND expense_date <= $3::DATE
                `,
                [userId, monthStart, monthEnd]
            ),

            db.query(
                `
                SELECT
                    c.id AS category_id,
                    c.category_name,
                    COALESCE(SUM(e.amount), 0) AS total_amount,
                    COUNT(e.id) AS expense_count
                FROM personal_expense_categories c
                LEFT JOIN personal_expenses e
                    ON e.category_id = c.id
                   AND e.user_id = $1
                   AND e.expense_date >= $2::DATE
                   AND e.expense_date <= $3::DATE
                WHERE c.user_id = $1
                GROUP BY c.id, c.category_name
                HAVING COALESCE(SUM(e.amount), 0) > 0
                ORDER BY total_amount DESC, c.category_name ASC
                `,
                [userId, monthStart, monthEnd]
            ),

            db.query(
                `
                SELECT
                    COALESCE(SUM(borrow_amount), 0) AS total_borrow,
                    COUNT(*) AS borrow_count
                FROM personal_borrow
                WHERE user_id = $1
                  AND take_date >= $2::DATE
                  AND take_date <= $3::DATE
                `,
                [userId, monthStart, monthEnd]
            ),

            db.query(
                `
                SELECT
                    COALESCE(SUM(total_loan_amount), 0) AS total_loan,
                    COUNT(*) AS loan_count
                FROM personal_loans
                WHERE user_id = $1
                  AND created_at >= $2::TIMESTAMP
                  AND created_at < ($3::DATE + INTERVAL '1 day')
                `,
                [userId, monthStart, monthEnd]
            ),

            db.query(
                `
                SELECT
                    COALESCE(SUM(emi_amount), 0) AS total_emi_paid,
                    COUNT(*) AS emi_count
                FROM personal_loan_emi_payments
                WHERE user_id = $1
                  AND payment_date >= $2::DATE
                  AND payment_date <= $3::DATE
                `,
                [userId, monthStart, monthEnd]
            ),
        ]);

        const overview = overviewResult.rows[0] || {};

        const workPayment = numberValue(overview.work_payment);
        const businessPayment = numberValue(overview.business_payment);
        const totalIncome = workPayment + businessPayment;

        const totalExpenses = numberValue(
            expenseSummaryResult.rows[0]?.total_expenses
        );
        const expenseCount = Number(
            expenseSummaryResult.rows[0]?.expense_count || 0
        );

        const totalBorrow = numberValue(borrowResult.rows[0]?.total_borrow);
        const borrowCount = Number(borrowResult.rows[0]?.borrow_count || 0);

        const totalLoan = numberValue(loanResult.rows[0]?.total_loan);
        const loanCount = Number(loanResult.rows[0]?.loan_count || 0);

        const totalEmiPaid = numberValue(emiResult.rows[0]?.total_emi_paid);
        const emiCount = Number(emiResult.rows[0]?.emi_count || 0);

        const totalSavings = totalIncome - totalExpenses - totalEmiPaid;

        const result =
            totalSavings > 0
                ? "profit"
                : totalSavings < 0
                ? "loss"
                : "break_even";

        const savingsRate =
            totalIncome > 0 ? (totalSavings / totalIncome) * 100 : 0;

        const expenseCategories = expenseCategoriesResult.rows.map((row) => ({
            category_id: row.category_id,
            category_name: row.category_name,
            total_amount: numberValue(row.total_amount),
            expense_count: Number(row.expense_count || 0),
        }));

        res.json({
            success: true,
            data: {
                report: {
                    title: "Month Report",
                    month: formatMonthName(monthStart),
                    month_start: monthStart,
                    month_end: monthEnd,
                    generated_at: new Date().toISOString(),
                },
                summary: {
                    work_payment: workPayment,
                    business_payment: businessPayment,
                    total_income: totalIncome,
                    total_borrow: totalBorrow,
                    borrow_count: borrowCount,
                    total_loan: totalLoan,
                    loan_count: loanCount,
                    total_expenses: totalExpenses,
                    expense_count: expenseCount,
                    total_emi_paid: totalEmiPaid,
                    emi_count: emiCount,
                    total_savings: totalSavings,
                    savings_rate: Number(savingsRate.toFixed(2)),
                    result,
                },
                expenses: {
                    categories: expenseCategories,
                    total: totalExpenses,
                    count: expenseCount,
                },
            },
        });
    } catch (error) {
        console.error("Error fetching export report:", error);

        res.status(500).json({
            error: error.message || "Internal server error",
        });
    }
});

module.exports = router;