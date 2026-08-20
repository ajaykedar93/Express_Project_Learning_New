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

// ==================== GET OVERVIEW - MAIN API ====================
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
        // 1. GET MANUAL DATA FROM OVERVIEW TABLE
        // ============================================================
        const overviewQuery = `
            SELECT 
                total_work,
                total_business,
                work_payment,
                business_payment,
                month_start
            FROM personal_overview
            WHERE user_id = $1 AND month_start = $2
        `;
        const overviewResult = await db.query(overviewQuery, [userId, monthStart]);
        
        let overview = {
            total_work: 0,
            total_business: 0,
            work_payment: 0,
            business_payment: 0,
            month_start: monthStart,
            month_display: formatMonthDisplay(monthStart)
        };

        if (overviewResult.rows.length > 0) {
            overview = {
                ...overviewResult.rows[0],
                month_display: formatMonthDisplay(monthStart)
            };
        }

        // ============================================================
        // 2. GET TOTAL EXPENSES FROM EXPENSE PAGE
        // ============================================================
        const expenseQuery = `
            SELECT COALESCE(SUM(amount), 0) as total_expenses
            FROM personal_expenses
            WHERE user_id = $1 
            AND DATE_TRUNC('month', expense_date) = $2::DATE
        `;
        const expenseResult = await db.query(expenseQuery, [userId, monthStart]);
        const totalExpenses = parseFloat(expenseResult.rows[0].total_expenses);

        const expenseCountQuery = `
            SELECT COUNT(*) as expense_count
            FROM personal_expenses
            WHERE user_id = $1 
            AND DATE_TRUNC('month', expense_date) = $2::DATE
        `;
        const expenseCountResult = await db.query(expenseCountQuery, [userId, monthStart]);
        const expenseCount = parseInt(expenseCountResult.rows[0].expense_count);

        // ============================================================
        // 3. GET TOTAL BORROW FROM LOANBORROW PAGE
        // ============================================================
        const borrowQuery = `
            SELECT COALESCE(SUM(borrow_amount), 0) as total_borrow
            FROM personal_borrow
            WHERE user_id = $1 
            AND DATE_TRUNC('month', take_date) = $2::DATE
        `;
        const borrowResult = await db.query(borrowQuery, [userId, monthStart]);
        const totalBorrow = parseFloat(borrowResult.rows[0].total_borrow);

        const borrowCountQuery = `
            SELECT COUNT(*) as borrow_count
            FROM personal_borrow
            WHERE user_id = $1 
            AND DATE_TRUNC('month', take_date) = $2::DATE
        `;
        const borrowCountResult = await db.query(borrowCountQuery, [userId, monthStart]);
        const borrowCount = parseInt(borrowCountResult.rows[0].borrow_count);

        // ============================================================
        // 4. GET TOTAL EMI PAID FROM LOANBORROW PAGE
        // ============================================================
        const emiQuery = `
            SELECT COALESCE(SUM(emi_amount), 0) as total_emi_paid
            FROM personal_loan_emi_payments
            WHERE user_id = $1 
            AND DATE_TRUNC('month', payment_date) = $2::DATE
        `;
        const emiResult = await db.query(emiQuery, [userId, monthStart]);
        const totalEmiPaid = parseFloat(emiResult.rows[0].total_emi_paid);

        const emiCountQuery = `
            SELECT COUNT(*) as emi_count
            FROM personal_loan_emi_payments
            WHERE user_id = $1 
            AND DATE_TRUNC('month', payment_date) = $2::DATE
        `;
        const emiCountResult = await db.query(emiCountQuery, [userId, monthStart]);
        const emiCount = parseInt(emiCountResult.rows[0].emi_count);

        // ============================================================
        // 5. GET TOTAL PAYMENT STATS FROM PAYMENT PAGE
        // ============================================================
        const paymentQuery = `
            SELECT 
                COALESCE(SUM(CASE WHEN status = 'received' THEN amount ELSE 0 END), 0) as total_received,
                COALESCE(SUM(CASE WHEN status = 'pending' THEN amount ELSE 0 END), 0) as total_pending,
                COALESCE(SUM(CASE WHEN status = 'overdue' THEN amount ELSE 0 END), 0) as total_overdue,
                COALESCE(SUM(CASE WHEN status = 'lost' THEN amount ELSE 0 END), 0) as total_lost,
                COALESCE(SUM(amount), 0) as total_payments
            FROM personal_payments
            WHERE user_id = $1 
            AND DATE_TRUNC('month', payment_date) = $2::DATE
        `;
        const paymentResult = await db.query(paymentQuery, [userId, monthStart]);
        
        const totalReceived = parseFloat(paymentResult.rows[0].total_received);
        const totalPending = parseFloat(paymentResult.rows[0].total_pending);
        const totalOverdue = parseFloat(paymentResult.rows[0].total_overdue);
        const totalLost = parseFloat(paymentResult.rows[0].total_lost);
        const totalPayments = parseFloat(paymentResult.rows[0].total_payments);

        const paymentCountQuery = `
            SELECT 
                status,
                COUNT(*) as count
            FROM personal_payments
            WHERE user_id = $1 
            AND DATE_TRUNC('month', payment_date) = $2::DATE
            GROUP BY status
        `;
        const paymentCountResult = await db.query(paymentCountQuery, [userId, monthStart]);
        
        let paymentCounts = {
            received: 0,
            pending: 0,
            overdue: 0,
            lost: 0
        };
        
        paymentCountResult.rows.forEach(row => {
            if (row.status === 'received') paymentCounts.received = parseInt(row.count);
            else if (row.status === 'pending') paymentCounts.pending = parseInt(row.count);
            else if (row.status === 'overdue') paymentCounts.overdue = parseInt(row.count);
            else if (row.status === 'lost') paymentCounts.lost = parseInt(row.count);
        });

        // ============================================================
        // 6. CALCULATE TOTALS
        // ============================================================
        const totalPayment = parseFloat(overview.work_payment) + parseFloat(overview.business_payment);
        const monthlySaving = totalPayment - totalExpenses + totalEmiPaid;

        // ============================================================
        // 7. GET ACTIVE BORROWS
        // ============================================================
        const activeBorrowQuery = `
            SELECT 
                b.id,
                b.person_name,
                b.borrow_amount,
                b.return_date,
                COALESCE(SUM(r.repayment_amount), 0) as total_repaid,
                (b.borrow_amount - COALESCE(SUM(r.repayment_amount), 0)) as remaining_amount,
                (b.return_date - CURRENT_DATE) as days_remaining
            FROM personal_borrow b
            LEFT JOIN personal_borrow_repayments r ON b.id = r.borrow_id
            WHERE b.user_id = $1 AND b.status = 'active'
            GROUP BY b.id
            ORDER BY b.return_date ASC
            LIMIT 5
        `;
        const activeBorrowResult = await db.query(activeBorrowQuery, [userId]);

        // ============================================================
        // 8. GET ACTIVE LOANS
        // ============================================================
        const activeLoanQuery = `
            SELECT 
                l.id,
                l.bank_name,
                l.total_loan_amount,
                l.emi_amount,
                l.total_emis,
                l.next_emi_date,
                COUNT(e.id) as paid_emis,
                (l.total_emis - COUNT(e.id)) as remaining_emis,
                (l.next_emi_date - CURRENT_DATE) as days_until_next_emi
            FROM personal_loans l
            LEFT JOIN personal_loan_emi_payments e ON l.id = e.loan_id
            WHERE l.user_id = $1 AND l.status = 'active'
            GROUP BY l.id
            ORDER BY l.next_emi_date ASC
            LIMIT 5
        `;
        const activeLoanResult = await db.query(activeLoanQuery, [userId]);

        // ============================================================
        // 9. GET OVERDUE PAYMENTS
        // ============================================================
        const overduePaymentsQuery = `
            SELECT 
                id,
                person_name,
                amount,
                payment_date,
                (CURRENT_DATE - payment_date) as days_late
            FROM personal_payments
            WHERE user_id = $1 
            AND status = 'overdue'
            ORDER BY payment_date ASC
            LIMIT 5
        `;
        const overduePaymentsResult = await db.query(overduePaymentsQuery, [userId]);

        // ============================================================
        // 10. GET PENDING PAYMENTS
        // ============================================================
        const pendingPaymentsQuery = `
            SELECT 
                id,
                person_name,
                amount,
                payment_date,
                (CURRENT_DATE - payment_date) as days_late
            FROM personal_payments
            WHERE user_id = $1 
            AND status = 'pending'
            AND DATE_TRUNC('month', payment_date) = $2::DATE
            ORDER BY payment_date ASC
            LIMIT 5
        `;
        const pendingPaymentsResult = await db.query(pendingPaymentsQuery, [userId, monthStart]);

        // ============================================================
        // 11. GET RECENT EXPENSES
        // ============================================================
        const recentExpensesQuery = `
            SELECT 
                e.id,
                e.amount,
                e.expense_date,
                e.notes,
                c.category_name,
                c.icon,
                c.color
            FROM personal_expenses e
            JOIN personal_expense_categories c ON e.category_id = c.id
            WHERE e.user_id = $1 
            AND DATE_TRUNC('month', e.expense_date) = $2::DATE
            ORDER BY e.expense_date DESC
            LIMIT 5
        `;
        const recentExpensesResult = await db.query(recentExpensesQuery, [userId, monthStart]);

        // ============================================================
        // 12. GET CATEGORY BREAKDOWN
        // ============================================================
        const categoryQuery = `
            SELECT 
                c.id as category_id,
                c.category_name,
                c.icon,
                c.color,
                COUNT(e.id) as expense_count,
                COALESCE(SUM(e.amount), 0) as total_amount
            FROM personal_expense_categories c
            LEFT JOIN personal_expenses e 
                ON e.category_id = c.id 
                AND e.user_id = $1 
                AND DATE_TRUNC('month', e.expense_date) = $2::DATE
            WHERE c.user_id = $1
            GROUP BY c.id, c.category_name, c.icon, c.color
            ORDER BY total_amount DESC
        `;
        const categoryResult = await db.query(categoryQuery, [userId, monthStart]);

        // ============================================================
        // 13. GET WEEKLY BREAKDOWN
        // ============================================================
        const weekQuery = `
            SELECT 
                CASE 
                    WHEN EXTRACT(DAY FROM expense_date) BETWEEN 1 AND 7 THEN 1
                    WHEN EXTRACT(DAY FROM expense_date) BETWEEN 8 AND 14 THEN 2
                    WHEN EXTRACT(DAY FROM expense_date) BETWEEN 15 AND 21 THEN 3
                    ELSE 4
                END as week_number,
                COUNT(*) as expense_count,
                COALESCE(SUM(amount), 0) as total_amount
            FROM personal_expenses
            WHERE user_id = $1 
            AND DATE_TRUNC('month', expense_date) = $2::DATE
            GROUP BY week_number
            ORDER BY week_number
        `;
        const weekResult = await db.query(weekQuery, [userId, monthStart]);

        // ============================================================
        // 14. SEND RESPONSE
        // ============================================================
        res.json({
            success: true,
            data: {
                month: {
                    start: monthStart,
                    display: formatMonthDisplay(monthStart)
                },
                manual_data: {
                    total_work: parseInt(overview.total_work),
                    total_business: parseInt(overview.total_business),
                    work_payment: parseFloat(overview.work_payment),
                    business_payment: parseFloat(overview.business_payment)
                },
                calculated: {
                    total_payment: totalPayment,
                    total_expenses: totalExpenses,
                    total_borrow: totalBorrow,
                    total_emi_paid: totalEmiPaid,
                    monthly_saving: monthlySaving
                },
                expense_summary: {
                    total: totalExpenses,
                    count: expenseCount,
                    recent: recentExpensesResult.rows.map(row => ({
                        ...row,
                        amount: parseFloat(row.amount),
                        expense_date: formatDate(row.expense_date)
                    })),
                    category_breakdown: categoryResult.rows.map(row => ({
                        ...row,
                        total_amount: parseFloat(row.total_amount),
                        expense_count: parseInt(row.expense_count)
                    })),
                    weekly_breakdown: weekResult.rows.map(row => ({
                        week_number: parseInt(row.week_number),
                        expense_count: parseInt(row.expense_count),
                        total_amount: parseFloat(row.total_amount)
                    }))
                },
                borrow_summary: {
                    total: totalBorrow,
                    count: borrowCount,
                    active: activeBorrowResult.rows.map(row => ({
                        ...row,
                        borrow_amount: parseFloat(row.borrow_amount),
                        total_repaid: parseFloat(row.total_repaid),
                        remaining_amount: parseFloat(row.remaining_amount),
                        return_date: formatDate(row.return_date),
                        days_remaining: parseInt(row.days_remaining) || 0
                    }))
                },
                emi_summary: {
                    total_paid: totalEmiPaid,
                    count: emiCount,
                    active_loans: activeLoanResult.rows.map(row => ({
                        ...row,
                        total_loan_amount: parseFloat(row.total_loan_amount),
                        emi_amount: parseFloat(row.emi_amount),
                        paid_emis: parseInt(row.paid_emis),
                        remaining_emis: parseInt(row.remaining_emis),
                        next_emi_date: formatDate(row.next_emi_date),
                        days_until_next_emi: parseInt(row.days_until_next_emi) || 0
                    }))
                },
                payment_summary: {
                    totals: {
                        received: totalReceived,
                        pending: totalPending,
                        overdue: totalOverdue,
                        lost: totalLost,
                        total: totalPayments
                    },
                    counts: paymentCounts,
                    overdue_payments: overduePaymentsResult.rows.map(row => ({
                        ...row,
                        amount: parseFloat(row.amount),
                        payment_date: formatDate(row.payment_date),
                        days_late: parseInt(row.days_late)
                    })),
                    pending_payments: pendingPaymentsResult.rows.map(row => ({
                        ...row,
                        amount: parseFloat(row.amount),
                        payment_date: formatDate(row.payment_date),
                        days_late: parseInt(row.days_late)
                    }))
                }
            }
        });

    } catch (error) {
        console.error("Error fetching overview:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// ==================== CREATE OR UPDATE OVERVIEW ====================
router.post("/", authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { 
            month_start,
            total_work = 0,
            total_business = 0,
            work_payment = 0,
            business_payment = 0
        } = req.body;

        if (!month_start) {
            return res.status(400).json({ error: "month_start is required" });
        }

        let monthStart;
        try {
            monthStart = parseMonthStart(month_start);
        } catch (error) {
            return res.status(400).json({ error: error.message });
        }

        if (total_work < 0 || total_business < 0 || work_payment < 0 || business_payment < 0) {
            return res.status(400).json({ error: "All values must be >= 0" });
        }

        const query = `
            INSERT INTO personal_overview (
                user_id,
                month_start,
                total_work,
                total_business,
                work_payment,
                business_payment
            ) VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (user_id, month_start) 
            DO UPDATE SET
                total_work = EXCLUDED.total_work,
                total_business = EXCLUDED.total_business,
                work_payment = EXCLUDED.work_payment,
                business_payment = EXCLUDED.business_payment,
                updated_at = CURRENT_TIMESTAMP
            RETURNING *
        `;

        const result = await db.query(query, [
            userId,
            monthStart,
            total_work,
            total_business,
            work_payment,
            business_payment
        ]);

        res.json({
            success: true,
            message: "Overview saved successfully",
            data: {
                ...result.rows[0],
                month_display: formatMonthDisplay(monthStart),
                total_work: parseInt(result.rows[0].total_work),
                total_business: parseInt(result.rows[0].total_business),
                work_payment: parseFloat(result.rows[0].work_payment),
                business_payment: parseFloat(result.rows[0].business_payment)
            }
        });

    } catch (error) {
        console.error("Error saving overview:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// ==================== UPDATE OVERVIEW ====================
router.put("/", authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { 
            month_start,
            total_work,
            total_business,
            work_payment,
            business_payment
        } = req.body;

        if (!month_start) {
            return res.status(400).json({ error: "month_start is required" });
        }

        let monthStart;
        try {
            monthStart = parseMonthStart(month_start);
        } catch (error) {
            return res.status(400).json({ error: error.message });
        }

        const updates = [];
        const values = [];
        let paramCount = 1;

        if (total_work !== undefined) {
            if (total_work < 0) return res.status(400).json({ error: "total_work must be >= 0" });
            updates.push(`total_work = $${paramCount}`);
            values.push(total_work);
            paramCount++;
        }

        if (total_business !== undefined) {
            if (total_business < 0) return res.status(400).json({ error: "total_business must be >= 0" });
            updates.push(`total_business = $${paramCount}`);
            values.push(total_business);
            paramCount++;
        }

        if (work_payment !== undefined) {
            if (work_payment < 0) return res.status(400).json({ error: "work_payment must be >= 0" });
            updates.push(`work_payment = $${paramCount}`);
            values.push(work_payment);
            paramCount++;
        }

        if (business_payment !== undefined) {
            if (business_payment < 0) return res.status(400).json({ error: "business_payment must be >= 0" });
            updates.push(`business_payment = $${paramCount}`);
            values.push(business_payment);
            paramCount++;
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: "No fields to update" });
        }

        updates.push(`updated_at = CURRENT_TIMESTAMP`);
        values.push(userId, monthStart);

        const query = `
            UPDATE personal_overview
            SET ${updates.join(', ')}
            WHERE user_id = $${paramCount} AND month_start = $${paramCount + 1}
            RETURNING *
        `;

        const result = await db.query(query, values);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Overview not found for this month" });
        }

        res.json({
            success: true,
            message: "Overview updated successfully",
            data: {
                ...result.rows[0],
                month_display: formatMonthDisplay(monthStart),
                total_work: parseInt(result.rows[0].total_work),
                total_business: parseInt(result.rows[0].total_business),
                work_payment: parseFloat(result.rows[0].work_payment),
                business_payment: parseFloat(result.rows[0].business_payment)
            }
        });

    } catch (error) {
        console.error("Error updating overview:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// ==================== DELETE OVERVIEW ====================
router.delete("/", authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const monthStr = req.query.month;

        if (!monthStr) {
            return res.status(400).json({ error: "month parameter is required" });
        }

        let monthStart;
        try {
            monthStart = parseMonthStart(monthStr);
        } catch (error) {
            return res.status(400).json({ error: error.message });
        }

        const query = `
            DELETE FROM personal_overview
            WHERE user_id = $1 AND month_start = $2
            RETURNING *
        `;

        const result = await db.query(query, [userId, monthStart]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Overview not found for this month" });
        }

        res.json({
            success: true,
            message: `Overview for ${formatMonthDisplay(monthStart)} deleted successfully`,
            data: {
                ...result.rows[0],
                month_display: formatMonthDisplay(monthStart),
                total_work: parseInt(result.rows[0].total_work),
                total_business: parseInt(result.rows[0].total_business),
                work_payment: parseFloat(result.rows[0].work_payment),
                business_payment: parseFloat(result.rows[0].business_payment)
            }
        });

    } catch (error) {
        console.error("Error deleting overview:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// ==================== GET ALL MONTHS ====================
router.get("/months", authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;

        const query = `
            SELECT 
                month_start,
                total_work,
                total_business,
                work_payment,
                business_payment,
                created_at,
                updated_at
            FROM personal_overview
            WHERE user_id = $1
            ORDER BY month_start DESC
        `;

        const result = await db.query(query, [userId]);

        const months = result.rows.map(row => ({
            ...row,
            month_display: formatMonthDisplay(row.month_start),
            total_work: parseInt(row.total_work),
            total_business: parseInt(row.total_business),
            work_payment: parseFloat(row.work_payment),
            business_payment: parseFloat(row.business_payment),
            total_payment: parseFloat(row.work_payment) + parseFloat(row.business_payment)
        }));

        res.json({
            success: true,
            count: months.length,
            data: months
        });

    } catch (error) {
        console.error("Error fetching months:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// ==================== GET DASHBOARD ====================
router.get("/dashboard", authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const currentMonth = getCurrentMonthStart();

        const allTimeQuery = `
            SELECT 
                (SELECT COALESCE(SUM(work_payment + business_payment), 0) FROM personal_overview WHERE user_id = $1) as total_payment,
                (SELECT COALESCE(SUM(amount), 0) FROM personal_expenses WHERE user_id = $1) as total_expenses,
                (SELECT COALESCE(SUM(borrow_amount), 0) FROM personal_borrow WHERE user_id = $1) as total_borrow,
                (SELECT COALESCE(SUM(emi_amount), 0) FROM personal_loan_emi_payments WHERE user_id = $1) as total_emi_paid,
                (SELECT COALESCE(SUM(amount), 0) FROM personal_payments WHERE user_id = $1 AND status = 'received') as total_received,
                (SELECT COALESCE(SUM(amount), 0) FROM personal_payments WHERE user_id = $1 AND status = 'pending') as total_pending,
                (SELECT COALESCE(SUM(amount), 0) FROM personal_payments WHERE user_id = $1 AND status = 'overdue') as total_overdue,
                (SELECT COALESCE(SUM(amount), 0) FROM personal_payments WHERE user_id = $1 AND status = 'lost') as total_lost
        `;
        const allTimeResult = await db.query(allTimeQuery, [userId]);

        const currentMonthQuery = `
            SELECT 
                (SELECT COALESCE(SUM(work_payment + business_payment), 0) FROM personal_overview WHERE user_id = $1 AND month_start = $2) as total_payment,
                (SELECT COALESCE(SUM(amount), 0) FROM personal_expenses WHERE user_id = $1 AND DATE_TRUNC('month', expense_date) = $2::DATE) as total_expenses,
                (SELECT COALESCE(SUM(borrow_amount), 0) FROM personal_borrow WHERE user_id = $1 AND DATE_TRUNC('month', take_date) = $2::DATE) as total_borrow,
                (SELECT COALESCE(SUM(emi_amount), 0) FROM personal_loan_emi_payments WHERE user_id = $1 AND DATE_TRUNC('month', payment_date) = $2::DATE) as total_emi_paid
        `;
        const currentMonthResult = await db.query(currentMonthQuery, [userId, currentMonth]);

        const allTimeSavings = parseFloat(allTimeResult.rows[0].total_payment) 
            - parseFloat(allTimeResult.rows[0].total_expenses) 
            + parseFloat(allTimeResult.rows[0].total_emi_paid);

        const currentMonthSavings = parseFloat(currentMonthResult.rows[0].total_payment) 
            - parseFloat(currentMonthResult.rows[0].total_expenses) 
            + parseFloat(currentMonthResult.rows[0].total_emi_paid);

        res.json({
            success: true,
            data: {
                current_month: {
                    display: formatMonthDisplay(currentMonth),
                    start: currentMonth,
                    total_payment: parseFloat(currentMonthResult.rows[0].total_payment),
                    total_expenses: parseFloat(currentMonthResult.rows[0].total_expenses),
                    total_borrow: parseFloat(currentMonthResult.rows[0].total_borrow),
                    total_emi_paid: parseFloat(currentMonthResult.rows[0].total_emi_paid),
                    savings: currentMonthSavings
                },
                all_time: {
                    total_payment: parseFloat(allTimeResult.rows[0].total_payment),
                    total_expenses: parseFloat(allTimeResult.rows[0].total_expenses),
                    total_borrow: parseFloat(allTimeResult.rows[0].total_borrow),
                    total_emi_paid: parseFloat(allTimeResult.rows[0].total_emi_paid),
                    total_received: parseFloat(allTimeResult.rows[0].total_received),
                    total_pending: parseFloat(allTimeResult.rows[0].total_pending),
                    total_overdue: parseFloat(allTimeResult.rows[0].total_overdue),
                    total_lost: parseFloat(allTimeResult.rows[0].total_lost),
                    savings: allTimeSavings
                }
            }
        });

    } catch (error) {
        console.error("Error fetching dashboard stats:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

module.exports = router;