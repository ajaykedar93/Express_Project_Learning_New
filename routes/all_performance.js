const express = require("express");
const jwt = require("jsonwebtoken");
const router = express.Router();
const db = require("../db.js");

// ==================== MIDDLEWARE ====================
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: "Access denied. No token provided." });
    }

    jwt.verify(token, process.env.JWT_SECRET || "your_secret_key", (err, user) => {
        if (err) {
            return res.status(403).json({ error: "Invalid or expired token." });
        }
        req.user = user;
        next();
    });
};

// ==================== HELPER FUNCTIONS ====================
const parseMonthStart = (monthStr) => {
    const date = new Date(monthStr);
    if (isNaN(date.getTime())) {
        throw new Error("Invalid date format. Use '1 Jan 2026'");
    }
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    return `${year}-${month}-01`;
};

const formatMonthDisplay = (dateStr) => {
    const date = new Date(dateStr);
    const day = date.getDate();
    const month = date.toLocaleString('default', { month: 'short' });
    const year = date.getFullYear();
    return `${day} ${month} ${year}`;
};

const getCurrentMonthStart = () => {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    return `${year}-${month}-01`;
};

const formatDate = (date) => {
    const d = new Date(date);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};

// ==================== MAIN PERFORMANCE API ====================
router.get("/", authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const monthStr = req.query.month || formatMonthDisplay(getCurrentMonthStart());

        let monthStart;
        try {
            monthStart = parseMonthStart(monthStr);
        } catch (error) {
            return res.status(400).json({ error: error.message });
        }

        // ============================================================
        // 1. GET INCOME FROM OVERVIEW TABLE
        // ============================================================
        const incomeQuery = `
            SELECT 
                COALESCE(work_payment, 0) as work_payment,
                COALESCE(business_payment, 0) as business_payment,
                COALESCE(total_work, 0) as total_work,
                COALESCE(total_business, 0) as total_business
            FROM personal_overview
            WHERE user_id = $1 AND month_start = $2
        `;
        const incomeResult = await db.query(incomeQuery, [userId, monthStart]);
        
        let incomeData = {
            work_payment: 0,
            business_payment: 0,
            total_work: 0,
            total_business: 0
        };

        if (incomeResult.rows.length > 0) {
            incomeData = {
                work_payment: parseFloat(incomeResult.rows[0].work_payment),
                business_payment: parseFloat(incomeResult.rows[0].business_payment),
                total_work: parseInt(incomeResult.rows[0].total_work),
                total_business: parseInt(incomeResult.rows[0].total_business)
            };
        }

        const totalIncome = incomeData.work_payment + incomeData.business_payment;

        // ============================================================
        // 2. GET TOTAL EXPENSES
        // ============================================================
        const expenseQuery = `
            SELECT 
                COALESCE(SUM(amount), 0) as total_expenses,
                COUNT(*) as expense_count
            FROM personal_expenses
            WHERE user_id = $1 
            AND DATE_TRUNC('month', expense_date) = $2::DATE
        `;
        const expenseResult = await db.query(expenseQuery, [userId, monthStart]);
        const totalExpenses = parseFloat(expenseResult.rows[0].total_expenses);
        const expenseCount = parseInt(expenseResult.rows[0].expense_count);

        // ============================================================
        // 3. GET EXPENSES BY CATEGORY
        // ============================================================
        const categoryExpenseQuery = `
            SELECT 
                c.id as category_id,
                c.category_name,
                COALESCE(SUM(e.amount), 0) as total_amount,
                COUNT(e.id) as expense_count
            FROM personal_expense_categories c
            LEFT JOIN personal_expenses e 
                ON e.category_id = c.id 
                AND e.user_id = $1 
                AND DATE_TRUNC('month', e.expense_date) = $2::DATE
            WHERE c.user_id = $1
            GROUP BY c.id, c.category_name
            ORDER BY total_amount DESC
        `;
        const categoryExpenseResult = await db.query(categoryExpenseQuery, [userId, monthStart]);

        const categoryBreakdown = categoryExpenseResult.rows.map(row => ({
            category_id: row.category_id,
            category_name: row.category_name,
            icon: '📊',
            color: '#3B82F6',
            total_amount: parseFloat(row.total_amount),
            expense_count: parseInt(row.expense_count),
            percentage: totalExpenses > 0 ? ((parseFloat(row.total_amount) / totalExpenses) * 100) : 0
        }));

        // ============================================================
        // 4. GET EXPENSES BY WEEK
        // ============================================================
        const weeklyExpenseQuery = `
            SELECT 
                CASE 
                    WHEN EXTRACT(DAY FROM expense_date) BETWEEN 1 AND 7 THEN 1
                    WHEN EXTRACT(DAY FROM expense_date) BETWEEN 8 AND 14 THEN 2
                    WHEN EXTRACT(DAY FROM expense_date) BETWEEN 15 AND 21 THEN 3
                    ELSE 4
                END as week_number,
                COALESCE(SUM(amount), 0) as total_amount,
                COUNT(*) as expense_count
            FROM personal_expenses
            WHERE user_id = $1 
            AND DATE_TRUNC('month', expense_date) = $2::DATE
            GROUP BY week_number
            ORDER BY week_number
        `;
        const weeklyExpenseResult = await db.query(weeklyExpenseQuery, [userId, monthStart]);

        const weeklyBreakdown = weeklyExpenseResult.rows.map(row => ({
            week_number: parseInt(row.week_number),
            week_label: `Week ${row.week_number}`,
            total_amount: parseFloat(row.total_amount),
            expense_count: parseInt(row.expense_count),
            percentage: totalExpenses > 0 ? ((parseFloat(row.total_amount) / totalExpenses) * 100) : 0
        }));

        // ============================================================
        // 5. GET TOTAL BORROW
        // ============================================================
        const borrowQuery = `
            SELECT
                COALESCE(SUM(total_amount), 0) as total_borrow,
                COUNT(*) as borrow_count
            FROM personal_loans_borrow
            WHERE user_id = $1
            AND type = 'Borrow'
            AND DATE_TRUNC('month', take_date) = $2::DATE
        `;
        const borrowResult = await db.query(borrowQuery, [userId, monthStart]);
        const totalBorrow = parseFloat(borrowResult.rows[0].total_borrow);
        const borrowCount = parseInt(borrowResult.rows[0].borrow_count);

        // ============================================================
        // 6. GET TOTAL LOAN
        // ============================================================
        const loanQuery = `
            SELECT
                COALESCE(SUM(total_amount), 0) as total_loan,
                COUNT(*) as loan_count
            FROM personal_loans_borrow
            WHERE user_id = $1
            AND type = 'Loan'
            AND DATE_TRUNC('month', take_date) = $2::DATE
        `;
        const loanResult = await db.query(loanQuery, [userId, monthStart]);
        const totalLoan = parseFloat(loanResult.rows[0].total_loan);
        const loanCount = parseInt(loanResult.rows[0].loan_count);

        // ============================================================
        // 7. GET TOTAL EMI PAID
        // ============================================================
        const emiQuery = `
            SELECT 
                COALESCE(SUM(
                    CASE
                        WHEN payment_type = 'EMI' THEN amount
                        ELSE 0
                    END
                ), 0) as total_emi_paid,
                COUNT(*) as emi_count
            FROM personal_loan_emi_payments
            WHERE user_id = $1 
            AND DATE_TRUNC('month', payment_date) = $2::DATE
        `;
        const emiResult = await db.query(emiQuery, [userId, monthStart]);
        const totalEmiPaid = parseFloat(emiResult.rows[0].total_emi_paid);
        const emiCount = parseInt(emiResult.rows[0].emi_count);

        // ============================================================
        // 8. GET ACTIVE LOANS WITH REMAINING EMIs
        // ============================================================
        const activeLoanQuery = `
            SELECT 
                l.id,
                l.person_or_bank_name as bank_name,
                l.total_amount as total_loan_amount,
                l.emi_amount,
                l.number_of_emis as total_emis,
                l.next_emi_date,
                l.status,
                COUNT(CASE WHEN e.payment_type = 'EMI' THEN 1 END) as paid_emis,
                GREATEST(
                    l.number_of_emis -
                    COUNT(CASE WHEN e.payment_type = 'EMI' THEN 1 END),
                    0
                ) as remaining_emis,
                COALESCE(
                    SUM(
                        CASE
                            WHEN e.payment_type = 'EMI' THEN e.amount
                            ELSE 0
                        END
                    ),
                    0
                ) as total_paid,
                (l.next_emi_date - CURRENT_DATE) as days_until_next_emi
            FROM personal_loans_borrow l
            LEFT JOIN personal_loan_emi_payments e
                ON l.id = e.loan_borrow_id
               AND l.user_id = e.user_id
            WHERE l.user_id = $1
              AND l.type = 'Loan'
              AND l.status = 'Active'
            GROUP BY
                l.id,
                l.person_or_bank_name,
                l.total_amount,
                l.emi_amount,
                l.number_of_emis,
                l.next_emi_date,
                l.status
            ORDER BY l.next_emi_date ASC
        `;
        const activeLoanResult = await db.query(activeLoanQuery, [userId]);

        const activeLoans = activeLoanResult.rows.map(row => ({
            id: row.id,
            bank_name: row.bank_name,
            total_loan_amount: parseFloat(row.total_loan_amount),
            emi_amount: parseFloat(row.emi_amount),
            total_emis: parseInt(row.total_emis),
            paid_emis: parseInt(row.paid_emis),
            remaining_emis: parseInt(row.remaining_emis),
            next_emi_date: formatDate(row.next_emi_date),
            days_until_next_emi: parseInt(row.days_until_next_emi) || 0,
            status: row.status,
            total_paid: parseFloat(row.total_paid)
        }));

        const totalRemainingEmis = activeLoans.reduce((sum, loan) => sum + loan.remaining_emis, 0);
        const totalRemainingLoanAmount = activeLoans.reduce((sum, loan) => sum + (loan.remaining_emis * loan.emi_amount), 0);

        // ============================================================
        // 9. GET ACTIVE BORROWS WITH REMAINING AMOUNTS
        // ============================================================
        const activeBorrowQuery = `
            SELECT 
                b.id,
                b.person_or_bank_name as person_name,
                b.total_amount as borrow_amount,
                b.take_date,
                b.return_date,
                b.status,
                COALESCE(
                    SUM(
                        CASE
                            WHEN r.payment_type = 'Borrow Repayment'
                            THEN r.amount
                            ELSE 0
                        END
                    ),
                    0
                ) as total_repaid,
                GREATEST(
                    b.total_amount -
                    COALESCE(
                        SUM(
                            CASE
                                WHEN r.payment_type = 'Borrow Repayment'
                                THEN r.amount
                                ELSE 0
                            END
                        ),
                        0
                    ),
                    0
                ) as remaining_amount,
                (b.return_date - CURRENT_DATE) as days_remaining
            FROM personal_loans_borrow b
            LEFT JOIN personal_loan_emi_payments r
                ON b.id = r.loan_borrow_id
               AND b.user_id = r.user_id
            WHERE b.user_id = $1
              AND b.type = 'Borrow'
              AND b.status = 'Active'
            GROUP BY
                b.id,
                b.person_or_bank_name,
                b.total_amount,
                b.take_date,
                b.return_date,
                b.status
            ORDER BY b.return_date ASC
        `;
        const activeBorrowResult = await db.query(activeBorrowQuery, [userId]);

        const activeBorrows = activeBorrowResult.rows.map(row => ({
            id: row.id,
            person_name: row.person_name,
            borrow_amount: parseFloat(row.borrow_amount),
            total_repaid: parseFloat(row.total_repaid),
            remaining_amount: parseFloat(row.remaining_amount),
            take_date: formatDate(row.take_date),
            return_date: formatDate(row.return_date),
            days_remaining: parseInt(row.days_remaining) || 0,
            status: row.status
        }));

        const totalRemainingBorrow = activeBorrows.reduce((sum, borrow) => sum + borrow.remaining_amount, 0);

        // ============================================================
        // 10. GET PAYMENT SUMMARY
        // ============================================================
        const paymentQuery = `
            SELECT 
                COALESCE(SUM(CASE WHEN status = 'Received' THEN amount ELSE 0 END), 0) as total_received,
                COALESCE(SUM(CASE WHEN status = 'Pending' THEN amount ELSE 0 END), 0) as total_pending,
                COALESCE(SUM(CASE WHEN status = 'Overdue' THEN amount ELSE 0 END), 0) as total_overdue,
                COALESCE(SUM(CASE WHEN status = 'Lost' THEN amount ELSE 0 END), 0) as total_lost,
                COALESCE(SUM(amount), 0) as total_payments,
                COUNT(*) as payment_count
            FROM personal_payments
            WHERE user_id = $1 
            AND DATE_TRUNC('month', payment_date) = $2::DATE
        `;
        const paymentResult = await db.query(paymentQuery, [userId, monthStart]);

        const paymentSummary = {
            total_received: parseFloat(paymentResult.rows[0].total_received),
            total_pending: parseFloat(paymentResult.rows[0].total_pending),
            total_overdue: parseFloat(paymentResult.rows[0].total_overdue),
            total_lost: parseFloat(paymentResult.rows[0].total_lost),
            total_payments: parseFloat(paymentResult.rows[0].total_payments),
            payment_count: parseInt(paymentResult.rows[0].payment_count)
        };

        // ============================================================
        // 11. GET PAYMENT STATUS BREAKDOWN BY COUNT
        // ============================================================
        const paymentStatusQuery = `
            SELECT 
                status,
                COUNT(*) as count,
                COALESCE(SUM(amount), 0) as total_amount
            FROM personal_payments
            WHERE user_id = $1 
            AND DATE_TRUNC('month', payment_date) = $2::DATE
            GROUP BY status
        `;
        const paymentStatusResult = await db.query(paymentStatusQuery, [userId, monthStart]);

        const paymentStatusBreakdown = {
            received: { count: 0, amount: 0 },
            pending: { count: 0, amount: 0 },
            overdue: { count: 0, amount: 0 },
            lost: { count: 0, amount: 0 }
        };

        paymentStatusResult.rows.forEach(row => {
            if (String(row.status).toLowerCase() === 'received') {
                paymentStatusBreakdown.received.count = parseInt(row.count);
                paymentStatusBreakdown.received.amount = parseFloat(row.total_amount);
            } else if (String(row.status).toLowerCase() === 'pending') {
                paymentStatusBreakdown.pending.count = parseInt(row.count);
                paymentStatusBreakdown.pending.amount = parseFloat(row.total_amount);
            } else if (String(row.status).toLowerCase() === 'overdue') {
                paymentStatusBreakdown.overdue.count = parseInt(row.count);
                paymentStatusBreakdown.overdue.amount = parseFloat(row.total_amount);
            } else if (String(row.status).toLowerCase() === 'lost') {
                paymentStatusBreakdown.lost.count = parseInt(row.count);
                paymentStatusBreakdown.lost.amount = parseFloat(row.total_amount);
            }
        });

        // ============================================================
        // 12. CALCULATE SAVINGS
        // ============================================================
        const totalSavings = totalIncome - totalExpenses - totalEmiPaid;
        
        let savingsStatus = 'break_even';
        let savingsStatusMessage = '⚖️ Break Even';
        let savingsStatusColor = '#F59E0B';
        
        if (totalSavings > 0) {
            savingsStatus = 'profit';
            savingsStatusMessage = `🎉 Profit: ₹${totalSavings.toFixed(2)}`;
            savingsStatusColor = '#10B981';
        } else if (totalSavings < 0) {
            savingsStatus = 'loss';
            savingsStatusMessage = `⚠️ Loss: ₹${Math.abs(totalSavings).toFixed(2)}`;
            savingsStatusColor = '#EF4444';
        }

        const savingsRate = totalIncome > 0 ? ((totalSavings / totalIncome) * 100) : 0;

        // ============================================================
        // 13. GET RECENT TRANSACTIONS (Last 10)
        // ============================================================
        const recentTransactionsQuery = `
            SELECT 
                'expense' as type,
                e.id,
                e.amount,
                e.expense_date as transaction_date,
                e.notes as description,
                c.category_name as name,
                '📊' as icon,
                'expense' as category_type
            FROM personal_expenses e
            JOIN personal_expense_categories c ON e.category_id = c.id
            WHERE e.user_id = $1 AND DATE_TRUNC('month', e.expense_date) = $2::DATE
            
            UNION ALL
            
            SELECT 
                'payment' as type,
                p.id,
                p.amount,
                p.payment_date as transaction_date,
                p.notes as description,
                p.person_name as name,
                NULL as icon,
                'payment' as category_type
            FROM personal_payments p
            WHERE p.user_id = $1 AND DATE_TRUNC('month', p.payment_date) = $2::DATE
            
            ORDER BY transaction_date DESC
            LIMIT 10
        `;
        const recentTransactionsResult = await db.query(recentTransactionsQuery, [userId, monthStart]);

        const recentTransactions = recentTransactionsResult.rows.map(row => ({
            ...row,
            amount: parseFloat(row.amount),
            transaction_date: formatDate(row.transaction_date),
            display_date: new Date(row.transaction_date).toLocaleDateString('en-IN', { 
                day: '2-digit', 
                month: 'short', 
                year: 'numeric' 
            })
        }));

        // ============================================================
        // 14. GET QUICK STATS (All time)
        // ============================================================
        const quickStatsQuery = `
            SELECT 
                (SELECT COALESCE(SUM(work_payment + business_payment), 0) FROM personal_overview WHERE user_id = $1) as all_income,
                (SELECT COALESCE(SUM(amount), 0) FROM personal_expenses WHERE user_id = $1) as all_expenses,
                (SELECT COALESCE(SUM(total_amount), 0)
                 FROM personal_loans_borrow
                 WHERE user_id = $1 AND type = 'Borrow') as all_borrow,
                (SELECT COALESCE(SUM(total_amount), 0)
                 FROM personal_loans_borrow
                 WHERE user_id = $1 AND type = 'Loan') as all_loan,
                (SELECT COALESCE(SUM(
                    CASE WHEN payment_type = 'EMI' THEN amount ELSE 0 END
                ), 0)
                 FROM personal_loan_emi_payments
                 WHERE user_id = $1) as all_emi_paid,
                (SELECT COALESCE(SUM(amount), 0)
                 FROM personal_payments
                 WHERE user_id = $1 AND status = 'Received') as all_received
        `;
        const quickStatsResult = await db.query(quickStatsQuery, [userId]);

        const quickStats = {
            all_time_income: parseFloat(quickStatsResult.rows[0].all_income),
            all_time_expenses: parseFloat(quickStatsResult.rows[0].all_expenses),
            all_time_borrow: parseFloat(quickStatsResult.rows[0].all_borrow),
            all_time_loan: parseFloat(quickStatsResult.rows[0].all_loan),
            all_time_emi_paid: parseFloat(quickStatsResult.rows[0].all_emi_paid),
            all_time_received: parseFloat(quickStatsResult.rows[0].all_received),
            all_time_savings: parseFloat(quickStatsResult.rows[0].all_income) -
                               parseFloat(quickStatsResult.rows[0].all_expenses) -
                               parseFloat(quickStatsResult.rows[0].all_emi_paid)
        };

        // ============================================================
        // 15. SEND RESPONSE
        // ============================================================
        res.json({
            success: true,
            data: {
                month: {
                    start: monthStart,
                    display: formatMonthDisplay(monthStart)
                },
                summary: {
                    total_income: totalIncome,
                    total_work: incomeData.work_payment,
                    total_business: incomeData.business_payment,
                    total_expenses: totalExpenses,
                    expense_count: expenseCount,
                    total_borrow: totalBorrow,
                    borrow_count: borrowCount,
                    total_loan: totalLoan,
                    loan_count: loanCount,
                    total_emi_paid: totalEmiPaid,
                    emi_count: emiCount,
                    total_savings: totalSavings,
                    savings_rate: parseFloat(savingsRate.toFixed(2)),
                    savings_status: savingsStatus,
                    savings_status_message: savingsStatusMessage,
                    savings_status_color: savingsStatusColor
                },
                income_breakdown: {
                    work_payment: incomeData.work_payment,
                    business_payment: incomeData.business_payment,
                    work_percentage: totalIncome > 0 ? ((incomeData.work_payment / totalIncome) * 100) : 0,
                    business_percentage: totalIncome > 0 ? ((incomeData.business_payment / totalIncome) * 100) : 0,
                    total_work_count: incomeData.total_work,
                    total_business_count: incomeData.total_business
                },
                expense_breakdown: {
                    total: totalExpenses,
                    count: expenseCount,
                    categories: categoryBreakdown,
                    weekly: weeklyBreakdown
                },
                loan_borrow_summary: {
                    total_borrow: totalBorrow,
                    total_loan: totalLoan,
                    total_emi_paid: totalEmiPaid,
                    active_loans: activeLoans,
                    active_borrows: activeBorrows,
                    total_remaining_emis: totalRemainingEmis,
                    total_remaining_loan_amount: totalRemainingLoanAmount,
                    total_remaining_borrow_amount: totalRemainingBorrow,
                    total_debt_remaining: totalRemainingLoanAmount + totalRemainingBorrow
                },
                payment_summary: {
                    totals: {
                        received: paymentSummary.total_received,
                        pending: paymentSummary.total_pending,
                        overdue: paymentSummary.total_overdue,
                        lost: paymentSummary.total_lost,
                        total: paymentSummary.total_payments
                    },
                    breakdown: paymentStatusBreakdown,
                    count: paymentSummary.payment_count
                },
                recent_transactions: recentTransactions,
                quick_stats: quickStats
            }
        });

    } catch (error) {
        console.error("Error fetching performance data:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// ==================== GET WIDGETS ====================
router.get("/widgets", authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const monthStr = req.query.month || formatMonthDisplay(getCurrentMonthStart());

        let monthStart;
        try {
            monthStart = parseMonthStart(monthStr);
        } catch (error) {
            return res.status(400).json({ error: error.message });
        }

        // Top 5 expenses
        const topExpensesQuery = `
            SELECT 
                c.category_name,
                COALESCE(SUM(e.amount), 0) as total_amount
            FROM personal_expense_categories c
            JOIN personal_expenses e ON e.category_id = c.id
            WHERE e.user_id = $1 
            AND DATE_TRUNC('month', e.expense_date) = $2::DATE
            GROUP BY c.id, c.category_name
            ORDER BY total_amount DESC
            LIMIT 5
        `;
        const topExpensesResult = await db.query(topExpensesQuery, [userId, monthStart]);

        // Upcoming EMIs
        const upcomingEmisQuery = `
            SELECT 
                id,
                person_or_bank_name AS bank_name,
                emi_amount,
                next_emi_date,
                (next_emi_date - CURRENT_DATE) as days_until
            FROM personal_loans_borrow
            WHERE user_id = $1
              AND type = 'Loan'
              AND status = 'Active'
            ORDER BY next_emi_date ASC
            LIMIT 5
        `;
        const upcomingEmisResult = await db.query(upcomingEmisQuery, [userId]);

        // Overdue payments
        const overduePaymentsQuery = `
            SELECT 
                id,
                person_name,
                amount,
                payment_date,
                (CURRENT_DATE - payment_date) as days_overdue
            FROM personal_payments
            WHERE user_id = $1 AND status = 'Overdue'
            ORDER BY payment_date ASC
            LIMIT 5
        `;
        const overduePaymentsResult = await db.query(overduePaymentsQuery, [userId]);

        res.json({
            success: true,
            data: {
                top_expenses: topExpensesResult.rows.map(row => ({
                    ...row,
                    icon: '📊',
                    color: '#6366F1',
                    total_amount: parseFloat(row.total_amount)
                })),
                upcoming_emis: upcomingEmisResult.rows.map(row => ({
                    ...row,
                    emi_amount: parseFloat(row.emi_amount),
                    next_emi_date: formatDate(row.next_emi_date),
                    days_until: parseInt(row.days_until) || 0
                })),
                overdue_payments: overduePaymentsResult.rows.map(row => ({
                    ...row,
                    amount: parseFloat(row.amount),
                    payment_date: formatDate(row.payment_date),
                    days_overdue: parseInt(row.days_overdue) || 0
                }))
            }
        });

    } catch (error) {
        console.error("Error fetching widgets:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

module.exports = router;