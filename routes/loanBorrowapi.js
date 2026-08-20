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

const getDaysRemaining = (targetDate) => {
    const today = new Date();
    const target = new Date(targetDate);
    const diffTime = target - today;
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    return diffDays;
};

// ==================== BORROW APIs ====================

// GET - Get all borrow records with repayments
router.get("/borrow", authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;

        const query = `
            SELECT 
                b.id,
                b.person_name,
                b.borrow_amount,
                b.take_date,
                b.return_date,
                b.notes,
                b.status,
                b.created_at,
                b.updated_at,
                COALESCE(SUM(r.repayment_amount), 0) as total_repaid,
                (b.borrow_amount - COALESCE(SUM(r.repayment_amount), 0)) as remaining_amount,
                (b.return_date - CURRENT_DATE) as days_remaining,
                CASE 
                    WHEN b.return_date < CURRENT_DATE AND (b.borrow_amount - COALESCE(SUM(r.repayment_amount), 0)) > 0 
                    THEN 'overdue'
                    WHEN (b.borrow_amount - COALESCE(SUM(r.repayment_amount), 0)) <= 0 
                    THEN 'completed'
                    ELSE 'active'
                END as calculated_status,
                COUNT(r.id) as repayment_count
            FROM personal_borrow b
            LEFT JOIN personal_borrow_repayments r ON b.id = r.borrow_id
            WHERE b.user_id = $1
            GROUP BY b.id
            ORDER BY b.return_date ASC
        `;

        const result = await db.query(query, [userId]);

        const borrows = result.rows.map(row => ({
            ...row,
            borrow_amount: parseFloat(row.borrow_amount),
            total_repaid: parseFloat(row.total_repaid),
            remaining_amount: parseFloat(row.remaining_amount),
            take_date: formatDate(row.take_date),
            return_date: formatDate(row.return_date),
            days_remaining: parseInt(row.days_remaining) || 0,
            repayment_count: parseInt(row.repayment_count)
        }));

        res.json({
            success: true,
            count: borrows.length,
            data: borrows
        });

    } catch (error) {
        console.error("Error fetching borrow records:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// GET - Get single borrow record with repayments
router.get("/borrow/:id", authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const borrowId = req.params.id;

        const query = `
            SELECT 
                b.id,
                b.person_name,
                b.borrow_amount,
                b.take_date,
                b.return_date,
                b.notes,
                b.status,
                b.created_at,
                b.updated_at,
                COALESCE(SUM(r.repayment_amount), 0) as total_repaid,
                (b.borrow_amount - COALESCE(SUM(r.repayment_amount), 0)) as remaining_amount,
                (b.return_date - CURRENT_DATE) as days_remaining,
                CASE 
                    WHEN b.return_date < CURRENT_DATE AND (b.borrow_amount - COALESCE(SUM(r.repayment_amount), 0)) > 0 
                    THEN 'overdue'
                    WHEN (b.borrow_amount - COALESCE(SUM(r.repayment_amount), 0)) <= 0 
                    THEN 'completed'
                    ELSE 'active'
                END as calculated_status,
                COUNT(r.id) as repayment_count
            FROM personal_borrow b
            LEFT JOIN personal_borrow_repayments r ON b.id = r.borrow_id
            WHERE b.id = $1 AND b.user_id = $2
            GROUP BY b.id
        `;

        const result = await db.query(query, [borrowId, userId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Borrow record not found" });
        }

        const repaymentQuery = `
            SELECT 
                id,
                repayment_amount,
                payment_date,
                notes,
                created_at
            FROM personal_borrow_repayments
            WHERE borrow_id = $1 AND user_id = $2
            ORDER BY payment_date DESC
        `;
        const repaymentResult = await db.query(repaymentQuery, [borrowId, userId]);

        const borrow = {
            ...result.rows[0],
            borrow_amount: parseFloat(result.rows[0].borrow_amount),
            total_repaid: parseFloat(result.rows[0].total_repaid),
            remaining_amount: parseFloat(result.rows[0].remaining_amount),
            take_date: formatDate(result.rows[0].take_date),
            return_date: formatDate(result.rows[0].return_date),
            days_remaining: parseInt(result.rows[0].days_remaining) || 0,
            repayment_count: parseInt(result.rows[0].repayment_count),
            repayments: repaymentResult.rows.map(r => ({
                ...r,
                repayment_amount: parseFloat(r.repayment_amount),
                payment_date: formatDate(r.payment_date)
            }))
        };

        res.json({
            success: true,
            data: borrow
        });

    } catch (error) {
        console.error("Error fetching borrow record:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// POST - Add new borrow record
router.post("/borrow", authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { 
            person_name,
            borrow_amount,
            take_date,
            return_date,
            notes = ''
        } = req.body;

        if (!person_name || person_name.trim() === '') {
            return res.status(400).json({ error: "Person name is required" });
        }

        if (!borrow_amount || borrow_amount <= 0) {
            return res.status(400).json({ error: "Borrow amount must be greater than 0" });
        }

        if (!take_date) {
            return res.status(400).json({ error: "Take date is required" });
        }

        if (!return_date) {
            return res.status(400).json({ error: "Return date is required" });
        }

        const formattedTakeDate = formatDate(take_date);
        const formattedReturnDate = formatDate(return_date);

        const query = `
            INSERT INTO personal_borrow (
                user_id,
                person_name,
                borrow_amount,
                take_date,
                return_date,
                notes,
                status
            ) VALUES ($1, $2, $3, $4, $5, $6, 'active')
            RETURNING *
        `;

        const result = await db.query(query, [
            userId,
            person_name.trim(),
            borrow_amount,
            formattedTakeDate,
            formattedReturnDate,
            notes
        ]);

        res.json({
            success: true,
            message: "Borrow record added successfully",
            data: {
                ...result.rows[0],
                borrow_amount: parseFloat(result.rows[0].borrow_amount),
                take_date: formatDate(result.rows[0].take_date),
                return_date: formatDate(result.rows[0].return_date)
            }
        });

    } catch (error) {
        console.error("Error adding borrow record:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// PUT - Update borrow record
router.put("/borrow/:id", authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const borrowId = req.params.id;
        const { 
            person_name,
            borrow_amount,
            take_date,
            return_date,
            notes,
            status
        } = req.body;

        const checkQuery = `
            SELECT id FROM personal_borrow
            WHERE id = $1 AND user_id = $2
        `;
        const checkResult = await db.query(checkQuery, [borrowId, userId]);

        if (checkResult.rows.length === 0) {
            return res.status(404).json({ error: "Borrow record not found" });
        }

        const updates = [];
        const values = [];
        let paramCount = 1;

        if (person_name !== undefined) {
            updates.push(`person_name = $${paramCount}`);
            values.push(person_name.trim());
            paramCount++;
        }

        if (borrow_amount !== undefined) {
            if (borrow_amount <= 0) {
                return res.status(400).json({ error: "Borrow amount must be greater than 0" });
            }
            updates.push(`borrow_amount = $${paramCount}`);
            values.push(borrow_amount);
            paramCount++;
        }

        if (take_date !== undefined) {
            updates.push(`take_date = $${paramCount}`);
            values.push(formatDate(take_date));
            paramCount++;
        }

        if (return_date !== undefined) {
            updates.push(`return_date = $${paramCount}`);
            values.push(formatDate(return_date));
            paramCount++;
        }

        if (notes !== undefined) {
            updates.push(`notes = $${paramCount}`);
            values.push(notes);
            paramCount++;
        }

        if (status !== undefined) {
            updates.push(`status = $${paramCount}`);
            values.push(status);
            paramCount++;
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: "No fields to update" });
        }

        updates.push(`updated_at = CURRENT_TIMESTAMP`);
        values.push(borrowId, userId);

        const query = `
            UPDATE personal_borrow
            SET ${updates.join(', ')}
            WHERE id = $${paramCount} AND user_id = $${paramCount + 1}
            RETURNING *
        `;

        const result = await db.query(query, values);

        res.json({
            success: true,
            message: "Borrow record updated successfully",
            data: {
                ...result.rows[0],
                borrow_amount: parseFloat(result.rows[0].borrow_amount),
                take_date: formatDate(result.rows[0].take_date),
                return_date: formatDate(result.rows[0].return_date)
            }
        });

    } catch (error) {
        console.error("Error updating borrow record:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// DELETE - Delete borrow record
router.delete("/borrow/:id", authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const borrowId = req.params.id;

        const repaymentCheck = `
            SELECT COUNT(*) as count
            FROM personal_borrow_repayments
            WHERE borrow_id = $1 AND user_id = $2
        `;
        const repaymentResult = await db.query(repaymentCheck, [borrowId, userId]);

        if (parseInt(repaymentResult.rows[0].count) > 0) {
            return res.status(400).json({ 
                error: "Cannot delete borrow with repayments. Delete repayments first.",
                repayment_count: parseInt(repaymentResult.rows[0].count)
            });
        }

        const query = `
            DELETE FROM personal_borrow
            WHERE id = $1 AND user_id = $2
            RETURNING *
        `;

        const result = await db.query(query, [borrowId, userId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Borrow record not found" });
        }

        res.json({
            success: true,
            message: "Borrow record deleted successfully",
            data: result.rows[0]
        });

    } catch (error) {
        console.error("Error deleting borrow record:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// ==================== BORROW REPAYMENT APIs ====================

// POST - Add borrow repayment
router.post("/borrow/:id/repayment", authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const borrowId = req.params.id;
        const { 
            repayment_amount,
            payment_date,
            notes = ''
        } = req.body;

        if (!repayment_amount || repayment_amount <= 0) {
            return res.status(400).json({ error: "Repayment amount must be greater than 0" });
        }

        if (!payment_date) {
            return res.status(400).json({ error: "Payment date is required" });
        }

        const borrowCheck = `
            SELECT id, borrow_amount, 
                   COALESCE((SELECT SUM(repayment_amount) FROM personal_borrow_repayments WHERE borrow_id = $1), 0) as total_repaid
            FROM personal_borrow
            WHERE id = $1 AND user_id = $2
        `;
        const borrowResult = await db.query(borrowCheck, [borrowId, userId]);

        if (borrowResult.rows.length === 0) {
            return res.status(404).json({ error: "Borrow record not found" });
        }

        const totalRepaid = parseFloat(borrowResult.rows[0].total_repaid);
        const borrowAmount = parseFloat(borrowResult.rows[0].borrow_amount);

        if (totalRepaid + repayment_amount > borrowAmount) {
            return res.status(400).json({ 
                error: "Repayment amount exceeds remaining balance",
                remaining: borrowAmount - totalRepaid
            });
        }

        const formattedDate = formatDate(payment_date);

        const query = `
            INSERT INTO personal_borrow_repayments (
                user_id,
                borrow_id,
                repayment_amount,
                payment_date,
                notes
            ) VALUES ($1, $2, $3, $4, $5)
            RETURNING *
        `;

        const result = await db.query(query, [
            userId,
            borrowId,
            repayment_amount,
            formattedDate,
            notes
        ]);

        const newTotalRepaid = totalRepaid + repayment_amount;
        if (newTotalRepaid >= borrowAmount) {
            await db.query(
                `UPDATE personal_borrow SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
                [borrowId]
            );
        }

        res.json({
            success: true,
            message: "Repayment added successfully",
            data: {
                ...result.rows[0],
                repayment_amount: parseFloat(result.rows[0].repayment_amount),
                payment_date: formatDate(result.rows[0].payment_date)
            }
        });

    } catch (error) {
        console.error("Error adding repayment:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// GET - Get all repayments for a borrow
router.get("/borrow/:id/repayments", authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const borrowId = req.params.id;

        const query = `
            SELECT 
                id,
                repayment_amount,
                payment_date,
                notes,
                created_at,
                updated_at
            FROM personal_borrow_repayments
            WHERE borrow_id = $1 AND user_id = $2
            ORDER BY payment_date DESC
        `;

        const result = await db.query(query, [borrowId, userId]);

        res.json({
            success: true,
            count: result.rows.length,
            data: result.rows.map(row => ({
                ...row,
                repayment_amount: parseFloat(row.repayment_amount),
                payment_date: formatDate(row.payment_date)
            }))
        });

    } catch (error) {
        console.error("Error fetching repayments:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// DELETE - Delete repayment
router.delete("/repayment/:id", authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const repaymentId = req.params.id;

        const query = `
            DELETE FROM personal_borrow_repayments
            WHERE id = $1 AND user_id = $2
            RETURNING *
        `;

        const result = await db.query(query, [repaymentId, userId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Repayment not found" });
        }

        res.json({
            success: true,
            message: "Repayment deleted successfully",
            data: result.rows[0]
        });

    } catch (error) {
        console.error("Error deleting repayment:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// ==================== LOAN APIs ====================

// GET - Get all loans with EMI payments
router.get("/loan", authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;

        const query = `
            SELECT 
                l.id,
                l.bank_name,
                l.total_loan_amount,
                l.emi_amount,
                l.total_emis,
                l.next_emi_date,
                l.notes,
                l.status,
                l.created_at,
                l.updated_at,
                COUNT(e.id) as paid_emis,
                (l.total_emis - COUNT(e.id)) as remaining_emis,
                COALESCE(SUM(e.emi_amount), 0) as total_paid,
                (l.next_emi_date - CURRENT_DATE) as days_until_next_emi,
                CASE 
                    WHEN l.next_emi_date < CURRENT_DATE AND COUNT(e.id) < l.total_emis 
                    THEN 'overdue'
                    WHEN COUNT(e.id) >= l.total_emis 
                    THEN 'completed'
                    ELSE 'active'
                END as calculated_status
            FROM personal_loans l
            LEFT JOIN personal_loan_emi_payments e ON l.id = e.loan_id
            WHERE l.user_id = $1
            GROUP BY l.id
            ORDER BY l.next_emi_date ASC
        `;

        const result = await db.query(query, [userId]);

        const loans = result.rows.map(row => ({
            ...row,
            total_loan_amount: parseFloat(row.total_loan_amount),
            emi_amount: parseFloat(row.emi_amount),
            total_paid: parseFloat(row.total_paid),
            next_emi_date: formatDate(row.next_emi_date),
            paid_emis: parseInt(row.paid_emis),
            remaining_emis: parseInt(row.remaining_emis),
            days_until_next_emi: parseInt(row.days_until_next_emi) || 0
        }));

        res.json({
            success: true,
            count: loans.length,
            data: loans
        });

    } catch (error) {
        console.error("Error fetching loans:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// GET - Get single loan with EMI payments
router.get("/loan/:id", authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const loanId = req.params.id;

        const query = `
            SELECT 
                l.id,
                l.bank_name,
                l.total_loan_amount,
                l.emi_amount,
                l.total_emis,
                l.next_emi_date,
                l.notes,
                l.status,
                l.created_at,
                l.updated_at,
                COUNT(e.id) as paid_emis,
                (l.total_emis - COUNT(e.id)) as remaining_emis,
                COALESCE(SUM(e.emi_amount), 0) as total_paid,
                (l.next_emi_date - CURRENT_DATE) as days_until_next_emi,
                CASE 
                    WHEN l.next_emi_date < CURRENT_DATE AND COUNT(e.id) < l.total_emis 
                    THEN 'overdue'
                    WHEN COUNT(e.id) >= l.total_emis 
                    THEN 'completed'
                    ELSE 'active'
                END as calculated_status
            FROM personal_loans l
            LEFT JOIN personal_loan_emi_payments e ON l.id = e.loan_id
            WHERE l.id = $1 AND l.user_id = $2
            GROUP BY l.id
        `;

        const result = await db.query(query, [loanId, userId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Loan not found" });
        }

        const emiQuery = `
            SELECT 
                id,
                emi_amount,
                payment_date,
                notes,
                created_at
            FROM personal_loan_emi_payments
            WHERE loan_id = $1 AND user_id = $2
            ORDER BY payment_date DESC
        `;
        const emiResult = await db.query(emiQuery, [loanId, userId]);

        const loan = {
            ...result.rows[0],
            total_loan_amount: parseFloat(result.rows[0].total_loan_amount),
            emi_amount: parseFloat(result.rows[0].emi_amount),
            total_paid: parseFloat(result.rows[0].total_paid),
            next_emi_date: formatDate(result.rows[0].next_emi_date),
            paid_emis: parseInt(result.rows[0].paid_emis),
            remaining_emis: parseInt(result.rows[0].remaining_emis),
            days_until_next_emi: parseInt(result.rows[0].days_until_next_emi) || 0,
            emi_payments: emiResult.rows.map(e => ({
                ...e,
                emi_amount: parseFloat(e.emi_amount),
                payment_date: formatDate(e.payment_date)
            }))
        };

        res.json({
            success: true,
            data: loan
        });

    } catch (error) {
        console.error("Error fetching loan:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// POST - Add new loan
router.post("/loan", authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { 
            bank_name,
            total_loan_amount,
            emi_amount,
            total_emis,
            next_emi_date,
            notes = ''
        } = req.body;

        if (!bank_name || bank_name.trim() === '') {
            return res.status(400).json({ error: "Bank name is required" });
        }

        if (!total_loan_amount || total_loan_amount <= 0) {
            return res.status(400).json({ error: "Total loan amount must be greater than 0" });
        }

        if (!emi_amount || emi_amount <= 0) {
            return res.status(400).json({ error: "EMI amount must be greater than 0" });
        }

        if (!total_emis || total_emis <= 0) {
            return res.status(400).json({ error: "Total EMIs must be greater than 0" });
        }

        if (!next_emi_date) {
            return res.status(400).json({ error: "Next EMI date is required" });
        }

        const formattedDate = formatDate(next_emi_date);

        const query = `
            INSERT INTO personal_loans (
                user_id,
                bank_name,
                total_loan_amount,
                emi_amount,
                total_emis,
                next_emi_date,
                notes,
                status
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
            RETURNING *
        `;

        const result = await db.query(query, [
            userId,
            bank_name.trim(),
            total_loan_amount,
            emi_amount,
            total_emis,
            formattedDate,
            notes
        ]);

        res.json({
            success: true,
            message: "Loan added successfully",
            data: {
                ...result.rows[0],
                total_loan_amount: parseFloat(result.rows[0].total_loan_amount),
                emi_amount: parseFloat(result.rows[0].emi_amount),
                next_emi_date: formatDate(result.rows[0].next_emi_date)
            }
        });

    } catch (error) {
        console.error("Error adding loan:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// PUT - Update loan
router.put("/loan/:id", authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const loanId = req.params.id;
        const { 
            bank_name,
            total_loan_amount,
            emi_amount,
            total_emis,
            next_emi_date,
            notes,
            status
        } = req.body;

        const checkQuery = `
            SELECT id FROM personal_loans
            WHERE id = $1 AND user_id = $2
        `;
        const checkResult = await db.query(checkQuery, [loanId, userId]);

        if (checkResult.rows.length === 0) {
            return res.status(404).json({ error: "Loan not found" });
        }

        const updates = [];
        const values = [];
        let paramCount = 1;

        if (bank_name !== undefined) {
            updates.push(`bank_name = $${paramCount}`);
            values.push(bank_name.trim());
            paramCount++;
        }

        if (total_loan_amount !== undefined) {
            if (total_loan_amount <= 0) {
                return res.status(400).json({ error: "Total loan amount must be greater than 0" });
            }
            updates.push(`total_loan_amount = $${paramCount}`);
            values.push(total_loan_amount);
            paramCount++;
        }

        if (emi_amount !== undefined) {
            if (emi_amount <= 0) {
                return res.status(400).json({ error: "EMI amount must be greater than 0" });
            }
            updates.push(`emi_amount = $${paramCount}`);
            values.push(emi_amount);
            paramCount++;
        }

        if (total_emis !== undefined) {
            if (total_emis <= 0) {
                return res.status(400).json({ error: "Total EMIs must be greater than 0" });
            }
            updates.push(`total_emis = $${paramCount}`);
            values.push(total_emis);
            paramCount++;
        }

        if (next_emi_date !== undefined) {
            updates.push(`next_emi_date = $${paramCount}`);
            values.push(formatDate(next_emi_date));
            paramCount++;
        }

        if (notes !== undefined) {
            updates.push(`notes = $${paramCount}`);
            values.push(notes);
            paramCount++;
        }

        if (status !== undefined) {
            updates.push(`status = $${paramCount}`);
            values.push(status);
            paramCount++;
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: "No fields to update" });
        }

        updates.push(`updated_at = CURRENT_TIMESTAMP`);
        values.push(loanId, userId);

        const query = `
            UPDATE personal_loans
            SET ${updates.join(', ')}
            WHERE id = $${paramCount} AND user_id = $${paramCount + 1}
            RETURNING *
        `;

        const result = await db.query(query, values);

        res.json({
            success: true,
            message: "Loan updated successfully",
            data: {
                ...result.rows[0],
                total_loan_amount: parseFloat(result.rows[0].total_loan_amount),
                emi_amount: parseFloat(result.rows[0].emi_amount),
                next_emi_date: formatDate(result.rows[0].next_emi_date)
            }
        });

    } catch (error) {
        console.error("Error updating loan:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// DELETE - Delete loan
router.delete("/loan/:id", authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const loanId = req.params.id;

        const emiCheck = `
            SELECT COUNT(*) as count
            FROM personal_loan_emi_payments
            WHERE loan_id = $1 AND user_id = $2
        `;
        const emiResult = await db.query(emiCheck, [loanId, userId]);

        if (parseInt(emiResult.rows[0].count) > 0) {
            return res.status(400).json({ 
                error: "Cannot delete loan with EMI payments. Delete EMI payments first.",
                emi_count: parseInt(emiResult.rows[0].count)
            });
        }

        const query = `
            DELETE FROM personal_loans
            WHERE id = $1 AND user_id = $2
            RETURNING *
        `;

        const result = await db.query(query, [loanId, userId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Loan not found" });
        }

        res.json({
            success: true,
            message: "Loan deleted successfully",
            data: result.rows[0]
        });

    } catch (error) {
        console.error("Error deleting loan:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// ==================== LOAN EMI PAYMENT APIs ====================

// POST - Add EMI payment
router.post("/loan/:id/emi", authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const loanId = req.params.id;
        const { 
            emi_amount,
            payment_date,
            notes = ''
        } = req.body;

        if (!emi_amount || emi_amount <= 0) {
            return res.status(400).json({ error: "EMI amount must be greater than 0" });
        }

        if (!payment_date) {
            return res.status(400).json({ error: "Payment date is required" });
        }

        const loanCheck = `
            SELECT id, total_emis, 
                   COALESCE((SELECT COUNT(*) FROM personal_loan_emi_payments WHERE loan_id = $1), 0) as paid_emis
            FROM personal_loans
            WHERE id = $1 AND user_id = $2
        `;
        const loanResult = await db.query(loanCheck, [loanId, userId]);

        if (loanResult.rows.length === 0) {
            return res.status(404).json({ error: "Loan not found" });
        }

        const paidEmis = parseInt(loanResult.rows[0].paid_emis);
        const totalEmis = parseInt(loanResult.rows[0].total_emis);

        if (paidEmis >= totalEmis) {
            return res.status(400).json({ error: "All EMIs already paid" });
        }

        const formattedDate = formatDate(payment_date);

        const query = `
            INSERT INTO personal_loan_emi_payments (
                user_id,
                loan_id,
                emi_amount,
                payment_date,
                notes
            ) VALUES ($1, $2, $3, $4, $5)
            RETURNING *
        `;

        const result = await db.query(query, [
            userId,
            loanId,
            emi_amount,
            formattedDate,
            notes
        ]);

        const newPaidEmis = paidEmis + 1;
        if (newPaidEmis >= totalEmis) {
            await db.query(
                `UPDATE personal_loans SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
                [loanId]
            );
        } else {
            await db.query(
                `UPDATE personal_loans 
                 SET next_emi_date = (next_emi_date + INTERVAL '1 month')::DATE, 
                     updated_at = CURRENT_TIMESTAMP 
                 WHERE id = $1`,
                [loanId]
            );
        }

        res.json({
            success: true,
            message: "EMI payment added successfully",
            data: {
                ...result.rows[0],
                emi_amount: parseFloat(result.rows[0].emi_amount),
                payment_date: formatDate(result.rows[0].payment_date)
            }
        });

    } catch (error) {
        console.error("Error adding EMI payment:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// GET - Get all EMI payments for a loan
router.get("/loan/:id/emis", authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const loanId = req.params.id;

        const query = `
            SELECT 
                id,
                emi_amount,
                payment_date,
                notes,
                created_at,
                updated_at
            FROM personal_loan_emi_payments
            WHERE loan_id = $1 AND user_id = $2
            ORDER BY payment_date DESC
        `;

        const result = await db.query(query, [loanId, userId]);

        res.json({
            success: true,
            count: result.rows.length,
            data: result.rows.map(row => ({
                ...row,
                emi_amount: parseFloat(row.emi_amount),
                payment_date: formatDate(row.payment_date)
            }))
        });

    } catch (error) {
        console.error("Error fetching EMI payments:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// DELETE - Delete EMI payment
router.delete("/emi/:id", authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const emiId = req.params.id;

        const getLoanQuery = `
            SELECT loan_id FROM personal_loan_emi_payments
            WHERE id = $1 AND user_id = $2
        `;
        const getLoanResult = await db.query(getLoanQuery, [emiId, userId]);

        if (getLoanResult.rows.length === 0) {
            return res.status(404).json({ error: "EMI payment not found" });
        }

        const loanId = getLoanResult.rows[0].loan_id;

        const query = `
            DELETE FROM personal_loan_emi_payments
            WHERE id = $1 AND user_id = $2
            RETURNING *
        `;

        const result = await db.query(query, [emiId, userId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "EMI payment not found" });
        }

        const checkEmisQuery = `
            SELECT COUNT(*) as count, total_emis
            FROM personal_loan_emi_payments e
            JOIN personal_loans l ON e.loan_id = l.id
            WHERE e.loan_id = $1 AND e.user_id = $2
            GROUP BY l.total_emis
        `;
        const checkResult = await db.query(checkEmisQuery, [loanId, userId]);

        if (checkResult.rows.length > 0) {
            const paidEmis = parseInt(checkResult.rows[0].count);
            const totalEmis = parseInt(checkResult.rows[0].total_emis);
            if (paidEmis < totalEmis) {
                await db.query(
                    `UPDATE personal_loans SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
                    [loanId]
                );
            }
        } else {
            await db.query(
                `UPDATE personal_loans SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
                [loanId]
            );
        }

        res.json({
            success: true,
            message: "EMI payment deleted successfully",
            data: result.rows[0]
        });

    } catch (error) {
        console.error("Error deleting EMI payment:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// ==================== MONTHLY TOTALS APIs ====================

router.get("/totals", authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const monthStr = req.query.month || formatMonthDisplay(getCurrentMonthStart());

        let monthStart;
        try {
            monthStart = parseMonthStart(monthStr);
        } catch (error) {
            return res.status(400).json({ error: error.message });
        }

        const borrowQuery = `
            SELECT COALESCE(SUM(borrow_amount), 0) as total_borrow
            FROM personal_borrow
            WHERE user_id = $1 
            AND DATE_TRUNC('month', take_date) = $2::DATE
        `;
        const borrowResult = await db.query(borrowQuery, [userId, monthStart]);

        const loanQuery = `
            SELECT COALESCE(SUM(total_loan_amount), 0) as total_loan
            FROM personal_loans
            WHERE user_id = $1 
            AND DATE_TRUNC('month', created_at) = $2::DATE
        `;
        const loanResult = await db.query(loanQuery, [userId, monthStart]);

        const emiPaidQuery = `
            SELECT COALESCE(SUM(emi_amount), 0) as total_emi_paid
            FROM personal_loan_emi_payments
            WHERE user_id = $1 
            AND DATE_TRUNC('month', payment_date) = $2::DATE
        `;
        const emiPaidResult = await db.query(emiPaidQuery, [userId, monthStart]);

        const repaymentQuery = `
            SELECT COALESCE(SUM(repayment_amount), 0) as total_borrow_repaid
            FROM personal_borrow_repayments
            WHERE user_id = $1 
            AND DATE_TRUNC('month', payment_date) = $2::DATE
        `;
        const repaymentResult = await db.query(repaymentQuery, [userId, monthStart]);

        const activeBorrowQuery = `
            SELECT 
                b.id,
                b.person_name,
                b.borrow_amount,
                b.return_date,
                COALESCE(SUM(r.repayment_amount), 0) as total_repaid,
                (b.borrow_amount - COALESCE(SUM(r.repayment_amount), 0)) as remaining_amount
            FROM personal_borrow b
            LEFT JOIN personal_borrow_repayments r ON b.id = r.borrow_id
            WHERE b.user_id = $1 AND b.status = 'active'
            GROUP BY b.id
            ORDER BY b.return_date ASC
        `;
        const activeBorrowResult = await db.query(activeBorrowQuery, [userId]);

        const activeLoanQuery = `
            SELECT 
                l.id,
                l.bank_name,
                l.total_loan_amount,
                l.emi_amount,
                l.total_emis,
                l.next_emi_date,
                COUNT(e.id) as paid_emis,
                (l.total_emis - COUNT(e.id)) as remaining_emis
            FROM personal_loans l
            LEFT JOIN personal_loan_emi_payments e ON l.id = e.loan_id
            WHERE l.user_id = $1 AND l.status = 'active'
            GROUP BY l.id
            ORDER BY l.next_emi_date ASC
        `;
        const activeLoanResult = await db.query(activeLoanQuery, [userId]);

        res.json({
            success: true,
            data: {
                month: {
                    start: monthStart,
                    display: formatMonthDisplay(monthStart)
                },
                totals: {
                    total_borrow: parseFloat(borrowResult.rows[0].total_borrow),
                    total_loan: parseFloat(loanResult.rows[0].total_loan),
                    total_emi_paid: parseFloat(emiPaidResult.rows[0].total_emi_paid),
                    total_borrow_repaid: parseFloat(repaymentResult.rows[0].total_borrow_repaid)
                },
                active: {
                    borrows: activeBorrowResult.rows.map(row => ({
                        ...row,
                        borrow_amount: parseFloat(row.borrow_amount),
                        total_repaid: parseFloat(row.total_repaid),
                        remaining_amount: parseFloat(row.remaining_amount),
                        return_date: formatDate(row.return_date),
                        days_remaining: getDaysRemaining(row.return_date)
                    })),
                    loans: activeLoanResult.rows.map(row => ({
                        ...row,
                        total_loan_amount: parseFloat(row.total_loan_amount),
                        emi_amount: parseFloat(row.emi_amount),
                        paid_emis: parseInt(row.paid_emis),
                        remaining_emis: parseInt(row.remaining_emis),
                        next_emi_date: formatDate(row.next_emi_date),
                        days_until_next_emi: getDaysRemaining(row.next_emi_date)
                    }))
                }
            }
        });

    } catch (error) {
        console.error("Error fetching monthly totals:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// ==================== OVERVIEW HELPERS ====================

router.get("/overview/borrow", authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const monthStr = req.query.month || formatMonthDisplay(getCurrentMonthStart());

        let monthStart;
        try {
            monthStart = parseMonthStart(monthStr);
        } catch (error) {
            return res.status(400).json({ error: error.message });
        }

        const query = `
            SELECT 
                COALESCE(SUM(borrow_amount), 0) as total_borrow,
                COUNT(*) as borrow_count
            FROM personal_borrow
            WHERE user_id = $1 
            AND DATE_TRUNC('month', take_date) = $2::DATE
        `;

        const result = await db.query(query, [userId, monthStart]);

        res.json({
            success: true,
            data: {
                month: {
                    start: monthStart,
                    display: formatMonthDisplay(monthStart)
                },
                total_borrow: parseFloat(result.rows[0].total_borrow),
                borrow_count: parseInt(result.rows[0].borrow_count)
            }
        });

    } catch (error) {
        console.error("Error fetching borrow total for overview:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

router.get("/overview/emi-paid", authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const monthStr = req.query.month || formatMonthDisplay(getCurrentMonthStart());

        let monthStart;
        try {
            monthStart = parseMonthStart(monthStr);
        } catch (error) {
            return res.status(400).json({ error: error.message });
        }

        const query = `
            SELECT 
                COALESCE(SUM(emi_amount), 0) as total_emi_paid,
                COUNT(*) as emi_count
            FROM personal_loan_emi_payments
            WHERE user_id = $1 
            AND DATE_TRUNC('month', payment_date) = $2::DATE
        `;

        const result = await db.query(query, [userId, monthStart]);

        res.json({
            success: true,
            data: {
                month: {
                    start: monthStart,
                    display: formatMonthDisplay(monthStart)
                },
                total_emi_paid: parseFloat(result.rows[0].total_emi_paid),
                emi_count: parseInt(result.rows[0].emi_count)
            }
        });

    } catch (error) {
        console.error("Error fetching EMI paid for overview:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

module.exports = router;