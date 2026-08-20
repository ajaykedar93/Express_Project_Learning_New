const express = require("express");
const jwt = require("jsonwebtoken");
const router = express.Router();
const db = require("../db.js");

/*
|--------------------------------------------------------------------------
| Performance API - READ ONLY
|--------------------------------------------------------------------------
| Same business logic:
| 1. Monthly income from personal_overview
| 2. Monthly expenses + category + weekly breakdown
| 3. Monthly borrow
| 4. Monthly loan
| 5. Monthly EMI paid
| 6. Active loans + remaining EMI
| 7. Active borrows + remaining amount
| 8. Monthly payment status/count/amount
| 9. Monthly savings
| 10. All-time quick stats
| 11. Performance widgets
|
| This API does NOT add, update, or delete anything.
|--------------------------------------------------------------------------
*/

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(" ")[1];

    if (!token) {
        return res.status(401).json({
            error: "Access denied. No token provided.",
        });
    }

    jwt.verify(
        token,
        process.env.JWT_SECRET || "your_secret_key",
        (err, user) => {
            if (err) {
                return res.status(403).json({
                    error: "Invalid or expired token.",
                });
            }

            req.user = user;
            next();
        }
    );
};

const safeNumber = (value) => Number(value) || 0;

const parseMonthStart = (monthStr) => {
    if (!monthStr) {
        const now = new Date();

        return `${now.getFullYear()}-${String(
            now.getMonth() + 1
        ).padStart(2, "0")}-01`;
    }

    // Accept YYYY-MM directly.
    if (/^\d{4}-\d{2}$/.test(monthStr)) {
        const [year, month] = monthStr.split("-").map(Number);

        if (month < 1 || month > 12) {
            throw new Error("Invalid month.");
        }

        return `${year}-${String(month).padStart(2, "0")}-01`;
    }

    // Accept normal browser/API date strings.
    const date = new Date(monthStr);

    if (Number.isNaN(date.getTime())) {
        throw new Error(
            "Invalid date format. Use YYYY-MM or a valid date."
        );
    }

    return `${date.getFullYear()}-${String(
        date.getMonth() + 1
    ).padStart(2, "0")}-01`;
};

const formatMonthDisplay = (dateStr) => {
    const date = new Date(`${dateStr}T00:00:00`);

    return date.toLocaleDateString("en-IN", {
        month: "long",
        year: "numeric",
    });
};

const formatDate = (value) => {
    if (!value) return null;

    const d = new Date(value);

    if (Number.isNaN(d.getTime())) {
        return null;
    }

    return `${d.getFullYear()}-${String(
        d.getMonth() + 1
    ).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const emptyWidgets = () => ({
    top_expenses: [],
    upcoming_emis: [],
    overdue_payments: [],
});

router.get("/", authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const monthStart = parseMonthStart(req.query.month);

        // ============================================================
        // 1. INCOME FROM OVERVIEW
        // ============================================================
        const incomeResult = await db.query(
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
        );

        const incomeRow = incomeResult.rows[0] || {};

        const workPayment = safeNumber(incomeRow.work_payment);
        const businessPayment = safeNumber(incomeRow.business_payment);
        const totalWork = parseInt(incomeRow.total_work, 10) || 0;
        const totalBusiness =
            parseInt(incomeRow.total_business, 10) || 0;

        const totalIncome = workPayment + businessPayment;

        // ============================================================
        // 2. EXPENSE TOTAL
        // ============================================================
        const expenseResult = await db.query(
            `
            SELECT
                COALESCE(SUM(amount), 0) AS total_expenses,
                COUNT(*) AS expense_count
            FROM personal_expenses
            WHERE user_id = $1
              AND DATE_TRUNC('month', expense_date) = $2::DATE
            `,
            [userId, monthStart]
        );

        const totalExpenses = safeNumber(
            expenseResult.rows[0]?.total_expenses
        );
        const expenseCount =
            parseInt(expenseResult.rows[0]?.expense_count, 10) || 0;

        // ============================================================
        // 3. EXPENSE CATEGORY BREAKDOWN
        // ============================================================
        const categoryResult = await db.query(
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
               AND DATE_TRUNC('month', e.expense_date) = $2::DATE
            WHERE c.user_id = $1
            GROUP BY c.id, c.category_name
            HAVING COALESCE(SUM(e.amount), 0) > 0
            ORDER BY total_amount DESC, c.category_name ASC
            `,
            [userId, monthStart]
        );

        const categories = categoryResult.rows.map((row) => {
            const amount = safeNumber(row.total_amount);

            return {
                category_id: row.category_id,
                category_name: row.category_name,
                icon: "📊",
                color: "#3B82F6",
                total_amount: amount,
                expense_count:
                    parseInt(row.expense_count, 10) || 0,
                percentage:
                    totalExpenses > 0
                        ? Number(
                              ((amount / totalExpenses) * 100).toFixed(2)
                          )
                        : 0,
            };
        });

        // ============================================================
        // 4. WEEKLY EXPENSES
        // ============================================================
        const weeklyResult = await db.query(
            `
            SELECT
                CASE
                    WHEN EXTRACT(DAY FROM expense_date) BETWEEN 1 AND 7 THEN 1
                    WHEN EXTRACT(DAY FROM expense_date) BETWEEN 8 AND 14 THEN 2
                    WHEN EXTRACT(DAY FROM expense_date) BETWEEN 15 AND 21 THEN 3
                    ELSE 4
                END AS week_number,
                COALESCE(SUM(amount), 0) AS total_amount,
                COUNT(*) AS expense_count
            FROM personal_expenses
            WHERE user_id = $1
              AND DATE_TRUNC('month', expense_date) = $2::DATE
            GROUP BY week_number
            ORDER BY week_number
            `,
            [userId, monthStart]
        );

        const weekly = weeklyResult.rows.map((row) => {
            const amount = safeNumber(row.total_amount);

            return {
                week_number: parseInt(row.week_number, 10) || 0,
                week_label: `Week ${row.week_number}`,
                total_amount: amount,
                expense_count:
                    parseInt(row.expense_count, 10) || 0,
                percentage:
                    totalExpenses > 0
                        ? Number(
                              ((amount / totalExpenses) * 100).toFixed(2)
                          )
                        : 0,
            };
        });

        // ============================================================
        // 5. BORROW
        // ============================================================
        const borrowResult = await db.query(
            `
            SELECT
                COALESCE(SUM(borrow_amount), 0) AS total_borrow,
                COUNT(*) AS borrow_count
            FROM personal_borrow
            WHERE user_id = $1
              AND DATE_TRUNC('month', take_date) = $2::DATE
            `,
            [userId, monthStart]
        );

        const totalBorrow = safeNumber(
            borrowResult.rows[0]?.total_borrow
        );
        const borrowCount =
            parseInt(borrowResult.rows[0]?.borrow_count, 10) || 0;

        // ============================================================
        // 6. LOAN
        // ============================================================
        const loanResult = await db.query(
            `
            SELECT
                COALESCE(SUM(total_loan_amount), 0) AS total_loan,
                COUNT(*) AS loan_count
            FROM personal_loans
            WHERE user_id = $1
              AND DATE_TRUNC('month', created_at) = $2::DATE
            `,
            [userId, monthStart]
        );

        const totalLoan = safeNumber(
            loanResult.rows[0]?.total_loan
        );
        const loanCount =
            parseInt(loanResult.rows[0]?.loan_count, 10) || 0;

        // ============================================================
        // 7. EMI PAID
        // ============================================================
        const emiResult = await db.query(
            `
            SELECT
                COALESCE(SUM(emi_amount), 0) AS total_emi_paid,
                COUNT(*) AS emi_count
            FROM personal_loan_emi_payments
            WHERE user_id = $1
              AND payment_date >= $2::DATE
              AND payment_date < ($2::DATE + INTERVAL '1 month')
            `,
            [userId, monthStart]
        );

        const totalEmiPaid = safeNumber(
            emiResult.rows[0]?.total_emi_paid
        );
        const emiCount =
            parseInt(emiResult.rows[0]?.emi_count, 10) || 0;

        // ============================================================
        // 8. ACTIVE LOANS
        // ============================================================
        const activeLoanResult = await db.query(
            `
            SELECT
                l.id,
                l.bank_name,
                l.total_loan_amount,
                l.emi_amount,
                l.total_emis,
                l.next_emi_date,
                l.status,

                COUNT(e.id) AS paid_emis,

                GREATEST(
                    l.total_emis - COUNT(e.id),
                    0
                ) AS remaining_emis,

                COALESCE(
                    SUM(e.emi_amount),
                    0
                ) AS total_paid,

                (l.next_emi_date - CURRENT_DATE)
                    AS days_until_next_emi

            FROM personal_loans l

            LEFT JOIN personal_loan_emi_payments e
                ON l.id = e.loan_id
               AND l.user_id = e.user_id

            WHERE l.user_id = $1
              AND l.status = 'active'

            GROUP BY
                l.id,
                l.bank_name,
                l.total_loan_amount,
                l.emi_amount,
                l.total_emis,
                l.next_emi_date,
                l.status

            ORDER BY l.next_emi_date ASC
            `,
            [userId]
        );

        const activeLoans = activeLoanResult.rows.map((row) => ({
            id: row.id,
            bank_name: row.bank_name,
            total_loan_amount:
                safeNumber(row.total_loan_amount),
            emi_amount: safeNumber(row.emi_amount),
            total_emis:
                parseInt(row.total_emis, 10) || 0,
            paid_emis:
                parseInt(row.paid_emis, 10) || 0,
            remaining_emis:
                parseInt(row.remaining_emis, 10) || 0,
            next_emi_date:
                formatDate(row.next_emi_date),
            days_until_next_emi:
                parseInt(row.days_until_next_emi, 10) || 0,
            status: row.status,
            total_paid:
                safeNumber(row.total_paid),
        }));

        const totalRemainingEmis = activeLoans.reduce(
            (sum, loan) => sum + loan.remaining_emis,
            0
        );

        const totalRemainingLoanAmount = activeLoans.reduce(
            (sum, loan) =>
                sum +
                loan.remaining_emis * loan.emi_amount,
            0
        );

        // ============================================================
        // 9. ACTIVE BORROWS
        // ============================================================
        const activeBorrowResult = await db.query(
            `
            SELECT
                b.id,
                b.person_name,
                b.borrow_amount,
                b.take_date,
                b.return_date,
                b.status,

                COALESCE(
                    SUM(r.repayment_amount),
                    0
                ) AS total_repaid,

                GREATEST(
                    b.borrow_amount -
                    COALESCE(
                        SUM(r.repayment_amount),
                        0
                    ),
                    0
                ) AS remaining_amount,

                (b.return_date - CURRENT_DATE)
                    AS days_remaining

            FROM personal_borrow b

            LEFT JOIN personal_borrow_repayments r
                ON b.id = r.borrow_id
               AND b.user_id = r.user_id

            WHERE b.user_id = $1
              AND b.status = 'active'

            GROUP BY
                b.id,
                b.person_name,
                b.borrow_amount,
                b.take_date,
                b.return_date,
                b.status

            ORDER BY b.return_date ASC
            `,
            [userId]
        );

        const activeBorrows =
            activeBorrowResult.rows.map((row) => ({
                id: row.id,
                person_name: row.person_name,
                borrow_amount:
                    safeNumber(row.borrow_amount),
                total_repaid:
                    safeNumber(row.total_repaid),
                remaining_amount:
                    safeNumber(row.remaining_amount),
                take_date:
                    formatDate(row.take_date),
                return_date:
                    formatDate(row.return_date),
                days_remaining:
                    parseInt(row.days_remaining, 10) || 0,
                status: row.status,
            }));

        const totalRemainingBorrow =
            activeBorrows.reduce(
                (sum, borrow) =>
                    sum + borrow.remaining_amount,
                0
            );

        // ============================================================
        // 10. MONTHLY PAYMENT STATUS
        // ============================================================
        const paymentStatusResult = await db.query(
            `
            SELECT
                status,
                COUNT(*) AS count,
                COALESCE(SUM(amount), 0) AS total_amount
            FROM personal_payments
            WHERE user_id = $1
              AND payment_date >= $2::DATE
              AND payment_date < ($2::DATE + INTERVAL '1 month')
            GROUP BY status
            `,
            [userId, monthStart]
        );

        const paymentBreakdown = {
            received: { count: 0, amount: 0 },
            pending: { count: 0, amount: 0 },
            overdue: { count: 0, amount: 0 },
            lost: { count: 0, amount: 0 },
        };

        paymentStatusResult.rows.forEach((row) => {
            const status =
                String(row.status || "").toLowerCase();

            if (!paymentBreakdown[status]) {
                return;
            }

            paymentBreakdown[status] = {
                count:
                    parseInt(row.count, 10) || 0,
                amount:
                    safeNumber(row.total_amount),
            };
        });

        const paymentTotalResult = await db.query(
            `
            SELECT
                COALESCE(SUM(amount), 0) AS total_payments,
                COUNT(*) AS payment_count
            FROM personal_payments
            WHERE user_id = $1
              AND payment_date >= $2::DATE
              AND payment_date < ($2::DATE + INTERVAL '1 month')
            `,
            [userId, monthStart]
        );

        const totalPayments = safeNumber(
            paymentTotalResult.rows[0]?.total_payments
        );

        const paymentCount =
            parseInt(
                paymentTotalResult.rows[0]?.payment_count,
                10
            ) || 0;

        // ============================================================
        // 11. SAVINGS
        // Same performance-page logic:
        // Income - Expenses - EMI Paid
        // ============================================================
        const totalSavings =
            totalIncome -
            totalExpenses -
            totalEmiPaid;

        let savingsStatus = "break_even";
        let savingsStatusMessage = "⚖️ Break Even";
        let savingsStatusColor = "#F59E0B";

        if (totalSavings > 0) {
            savingsStatus = "profit";
            savingsStatusMessage =
                `🎉 Profit: ₹${totalSavings.toFixed(2)}`;
            savingsStatusColor = "#10B981";
        } else if (totalSavings < 0) {
            savingsStatus = "loss";
            savingsStatusMessage =
                `⚠️ Loss: ₹${Math.abs(totalSavings).toFixed(2)}`;
            savingsStatusColor = "#EF4444";
        }

        const savingsRate =
            totalIncome > 0
                ? (totalSavings / totalIncome) * 100
                : 0;

        // ============================================================
        // 12. ALL TIME QUICK STATS
        // ============================================================
        const quickStatsResult = await db.query(
            `
            SELECT
                (
                    SELECT COALESCE(
                        SUM(
                            work_payment +
                            business_payment
                        ),
                        0
                    )
                    FROM personal_overview
                    WHERE user_id = $1
                ) AS all_income,

                (
                    SELECT COALESCE(SUM(amount), 0)
                    FROM personal_expenses
                    WHERE user_id = $1
                ) AS all_expenses,

                (
                    SELECT COALESCE(
                        SUM(borrow_amount),
                        0
                    )
                    FROM personal_borrow
                    WHERE user_id = $1
                ) AS all_borrow,

                (
                    SELECT COALESCE(
                        SUM(total_loan_amount),
                        0
                    )
                    FROM personal_loans
                    WHERE user_id = $1
                ) AS all_loan,

                (
                    SELECT COALESCE(
                        SUM(emi_amount),
                        0
                    )
                    FROM personal_loan_emi_payments
                    WHERE user_id = $1
                ) AS all_emi_paid,

                (
                    SELECT COALESCE(SUM(amount), 0)
                    FROM personal_payments
                    WHERE user_id = $1
                      AND status = 'received'
                ) AS all_received
            `,
            [userId]
        );

        const quick = quickStatsResult.rows[0] || {};

        const allTimeIncome =
            safeNumber(quick.all_income);
        const allTimeExpenses =
            safeNumber(quick.all_expenses);
        const allTimeBorrow =
            safeNumber(quick.all_borrow);
        const allTimeLoan =
            safeNumber(quick.all_loan);
        const allTimeEmiPaid =
            safeNumber(quick.all_emi_paid);
        const allTimeReceived =
            safeNumber(quick.all_received);

        // ============================================================
        // 13. RESPONSE
        // ============================================================
        return res.json({
            success: true,

            data: {
                month: {
                    start: monthStart,
                    display:
                        formatMonthDisplay(monthStart),
                },

                summary: {
                    total_income: totalIncome,
                    total_work: totalWork,
                    total_business: totalBusiness,

                    total_expenses: totalExpenses,
                    expense_count: expenseCount,

                    total_borrow: totalBorrow,
                    borrow_count: borrowCount,

                    total_loan: totalLoan,
                    loan_count: loanCount,

                    total_emi_paid: totalEmiPaid,
                    emi_count: emiCount,

                    total_savings: totalSavings,
                    savings_rate: Number(
                        savingsRate.toFixed(2)
                    ),

                    savings_status: savingsStatus,
                    savings_status_message:
                        savingsStatusMessage,
                    savings_status_color:
                        savingsStatusColor,
                },

                income_breakdown: {
                    work_payment: workPayment,
                    business_payment: businessPayment,

                    work_percentage:
                        totalIncome > 0
                            ? Number(
                                  (
                                      (workPayment /
                                          totalIncome) *
                                      100
                                  ).toFixed(2)
                              )
                            : 0,

                    business_percentage:
                        totalIncome > 0
                            ? Number(
                                  (
                                      (businessPayment /
                                          totalIncome) *
                                      100
                                  ).toFixed(2)
                              )
                            : 0,

                    total_work_count: totalWork,
                    total_business_count:
                        totalBusiness,
                },

                expense_breakdown: {
                    total: totalExpenses,
                    count: expenseCount,
                    categories,
                    weekly,
                },

                loan_borrow_summary: {
                    total_borrow: totalBorrow,
                    total_loan: totalLoan,
                    total_emi_paid: totalEmiPaid,

                    active_loans: activeLoans,
                    active_borrows: activeBorrows,

                    total_remaining_emis:
                        totalRemainingEmis,

                    total_remaining_loan_amount:
                        totalRemainingLoanAmount,

                    total_remaining_borrow_amount:
                        totalRemainingBorrow,

                    total_debt_remaining:
                        totalRemainingLoanAmount +
                        totalRemainingBorrow,
                },

                payment_summary: {
                    totals: {
                        received:
                            paymentBreakdown.received.amount,
                        pending:
                            paymentBreakdown.pending.amount,
                        overdue:
                            paymentBreakdown.overdue.amount,
                        lost:
                            paymentBreakdown.lost.amount,

                        total: totalPayments,
                    },

                    breakdown: paymentBreakdown,
                    count: paymentCount,
                },

                quick_stats: {
                    all_time_income:
                        allTimeIncome,

                    all_time_expenses:
                        allTimeExpenses,

                    all_time_borrow:
                        allTimeBorrow,

                    all_time_loan:
                        allTimeLoan,

                    all_time_emi_paid:
                        allTimeEmiPaid,

                    all_time_received:
                        allTimeReceived,

                    all_time_savings:
                        allTimeIncome -
                        allTimeExpenses -
                        allTimeEmiPaid,
                },

                // Explicitly empty because the Performance page
                // now displays status counts instead of a transaction list.
                recent_transactions: [],
            },
        });
    } catch (error) {
        console.error(
            "Error fetching performance data:",
            error
        );

        return res.status(500).json({
            error:
                error.message ||
                "Internal server error",
        });
    }
});

// ================================================================
// PERFORMANCE WIDGETS
// ================================================================
router.get(
    "/widgets",
    authenticateToken,
    async (req, res) => {
        try {
            const userId = req.user.id;
            const monthStart =
                parseMonthStart(req.query.month);

            const topExpensesResult =
                await db.query(
                    `
                    SELECT
                        c.category_name,
                        COALESCE(
                            SUM(e.amount),
                            0
                        ) AS total_amount
                    FROM personal_expense_categories c
                    JOIN personal_expenses e
                        ON e.category_id = c.id
                    WHERE e.user_id = $1
                      AND DATE_TRUNC(
                            'month',
                            e.expense_date
                          ) = $2::DATE
                    GROUP BY
                        c.id,
                        c.category_name
                    ORDER BY total_amount DESC
                    LIMIT 5
                    `,
                    [userId, monthStart]
                );

            const upcomingEmiResult =
                await db.query(
                    `
                    SELECT
                        id,
                        bank_name,
                        emi_amount,
                        next_emi_date,
                        (
                            next_emi_date -
                            CURRENT_DATE
                        ) AS days_until
                    FROM personal_loans
                    WHERE user_id = $1
                      AND status = 'active'
                    ORDER BY next_emi_date ASC
                    LIMIT 5
                    `,
                    [userId]
                );

            const overdueResult =
                await db.query(
                    `
                    SELECT
                        id,
                        person_name,
                        amount,
                        payment_date,
                        (
                            CURRENT_DATE -
                            payment_date
                        ) AS days_overdue
                    FROM personal_payments
                    WHERE user_id = $1
                      AND status = 'overdue'
                    ORDER BY payment_date ASC
                    LIMIT 5
                    `,
                    [userId]
                );

            return res.json({
                success: true,

                data: {
                    top_expenses:
                        topExpensesResult.rows.map(
                            (row) => ({
                                ...row,
                                icon: "📊",
                                color: "#6366F1",
                                total_amount:
                                    safeNumber(
                                        row.total_amount
                                    ),
                            })
                        ),

                    upcoming_emis:
                        upcomingEmiResult.rows.map(
                            (row) => ({
                                ...row,
                                emi_amount:
                                    safeNumber(
                                        row.emi_amount
                                    ),
                                next_emi_date:
                                    formatDate(
                                        row.next_emi_date
                                    ),
                                days_until:
                                    parseInt(
                                        row.days_until,
                                        10
                                    ) || 0,
                            })
                        ),

                    overdue_payments:
                        overdueResult.rows.map(
                            (row) => ({
                                ...row,
                                amount:
                                    safeNumber(
                                        row.amount
                                    ),
                                payment_date:
                                    formatDate(
                                        row.payment_date
                                    ),
                                days_overdue:
                                    parseInt(
                                        row.days_overdue,
                                        10
                                    ) || 0,
                            })
                        ),
                },
            });
        } catch (error) {
            console.error(
                "Error fetching widgets:",
                error
            );

            return res.status(500).json({
                error:
                    error.message ||
                    "Internal server error",
            });
        }
    }
);

module.exports = router;