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
// Get first day of month from date string (e.g., "1 Jan 2026" -> "2026-01-01")
const parseMonthStart = (monthStr) => {
    if (!monthStr) {
        return getCurrentMonthStart();
    }

    if (/^\d{4}-\d{2}$/.test(monthStr)) {
        const [year, month] = monthStr.split("-").map(Number);

        if (month < 1 || month > 12) {
            throw new Error("Invalid month.");
        }

        return `${year}-${String(month).padStart(2, "0")}-01`;
    }

    const date = new Date(monthStr);

    if (Number.isNaN(date.getTime())) {
        throw new Error(
            "Invalid date format. Use YYYY-MM or a valid date."
        );
    }

    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");

    return `${year}-${month}-01`;
};

// Format date to "1 Jan 2026"
const formatMonthDisplay = (dateStr) => {
    const date = new Date(dateStr);
    const day = date.getDate();
    const month = date.toLocaleString('default', { month: 'short' });
    const year = date.getFullYear();
    return `${day} ${month} ${year}`;
};

// Get current month start date
const getCurrentMonthStart = () => {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    return `${year}-${month}-01`;
};

// Format date to YYYY-MM-DD
const formatDate = (date) => {
    const d = new Date(date);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};

// ==================== CATEGORY APIs ====================

// GET - Get all categories for the logged-in user
router.get("/categories", authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;

        const query = `
            SELECT
                id,
                category_name,
                is_default,
                created_at
            FROM personal_expense_categories
            WHERE user_id = $1
            ORDER BY is_default DESC, category_name ASC
        `;

        const result = await db.query(query, [userId]);

        res.json({
            success: true,
            count: result.rows.length,
            data: result.rows.map((row) => ({
                ...row,
                // Keep the frontend compatible even when icon/color
                // columns are not present in the database.
                icon: "📊",
                color: "#3B82F6",
            })),
        });
    } catch (error) {
        console.error("Error fetching categories:", error);

        res.status(500).json({
            error: error.message || "Internal server error",
        });
    }
});

// POST - Add a new custom category
router.post("/categories", authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;

        const categoryName =
            typeof req.body?.category_name === "string"
                ? req.body.category_name.trim()
                : "";

        if (!categoryName) {
            return res.status(400).json({
                error: "Category name is required.",
            });
        }

        if (categoryName.length < 2) {
            return res.status(400).json({
                error: "Category name must contain at least 2 characters.",
            });
        }

        if (categoryName.length > 50) {
            return res.status(400).json({
                error: "Category name cannot exceed 50 characters.",
            });
        }

        // Prevent duplicate names for the same user.
        const duplicateResult = await db.query(
            `
            SELECT id
            FROM personal_expense_categories
            WHERE user_id = $1
              AND LOWER(TRIM(category_name)) = LOWER($2)
            LIMIT 1
            `,
            [userId, categoryName]
        );

        if (duplicateResult.rows.length > 0) {
            return res.status(409).json({
                error: "Category already exists.",
            });
        }

        const insertResult = await db.query(
            `
            INSERT INTO personal_expense_categories (
                user_id,
                category_name,
                is_default
            )
            VALUES ($1, $2, false)
            RETURNING
                id,
                category_name,
                is_default,
                created_at
            `,
            [userId, categoryName]
        );

        const category = insertResult.rows[0];

        return res.status(201).json({
            success: true,
            message: "Category added successfully.",
            data: {
                ...category,
                icon: "📊",
                color: "#3B82F6",
            },
        });
    } catch (error) {
        console.error("Error adding category:", error);

        if (error.code === "23505") {
            return res.status(409).json({
                error: "Category already exists.",
            });
        }

        return res.status(500).json({
            error: error.message || "Internal server error",
        });
    }
});

// DELETE - Delete a user-created category.
// A category cannot be deleted when an expense is using it.
router.delete("/categories/:id", authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const categoryId = Number(req.params.id);

        if (!Number.isInteger(categoryId) || categoryId <= 0) {
            return res.status(400).json({
                error: "Invalid category id.",
            });
        }

        // Make sure the category belongs to this user.
        const categoryResult = await db.query(
            `
            SELECT
                id,
                category_name,
                is_default
            FROM personal_expense_categories
            WHERE id = $1
              AND user_id = $2
            LIMIT 1
            `,
            [categoryId, userId]
        );

        if (categoryResult.rows.length === 0) {
            return res.status(404).json({
                error: "Category not found.",
            });
        }

        const category = categoryResult.rows[0];

        if (category.is_default) {
            return res.status(400).json({
                error: "Default categories cannot be deleted.",
            });
        }

        // Do not allow deletion while any expense references it.
        const usageResult = await db.query(
            `
            SELECT COUNT(*)::INTEGER AS expense_count
            FROM personal_expenses
            WHERE category_id = $1
              AND user_id = $2
            `,
            [categoryId, userId]
        );

        const expenseCount =
            Number(usageResult.rows[0]?.expense_count) || 0;

        if (expenseCount > 0) {
            return res.status(409).json({
                error:
                    "Cannot delete category because expenses are using it. Delete or reassign those expenses first.",
                expense_count: expenseCount,
            });
        }

        const deleteResult = await db.query(
            `
            DELETE FROM personal_expense_categories
            WHERE id = $1
              AND user_id = $2
            RETURNING
                id,
                category_name,
                is_default
            `,
            [categoryId, userId]
        );

        if (deleteResult.rows.length === 0) {
            return res.status(404).json({
                error: "Category not found.",
            });
        }

        return res.json({
            success: true,
            message: "Category deleted successfully.",
            data: deleteResult.rows[0],
        });
    } catch (error) {
        console.error("Error deleting category:", error);

        // PostgreSQL FK/restrict protection.
        if (error.code === "23503") {
            return res.status(409).json({
                error:
                    "Category cannot be deleted because it is still being used.",
            });
        }

        return res.status(500).json({
            error: error.message || "Internal server error",
        });
    }
});

// ==================== EXPENSE APIs ====================

// GET - Get all expenses for a month
// GET /api/expenses?month=1 Jan 2026
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

        // 1. Get monthly total
        const totalQuery = `
            SELECT COALESCE(SUM(amount), 0) as total_expenses
            FROM personal_expenses
            WHERE user_id = $1 
            AND get_month_start(expense_date) = $2::DATE
        `;
        const totalResult = await db.query(totalQuery, [userId, monthStart]);
        const totalExpenses = parseFloat(totalResult.rows[0].total_expenses);

        // 2. Get weekly breakdown
        const weekQuery = `
            SELECT 
                get_expense_week(expense_date) as week_number,
                COUNT(*) as expense_count,
                COALESCE(SUM(amount), 0) as total_amount
            FROM personal_expenses
            WHERE user_id = $1 
            AND get_month_start(expense_date) = $2::DATE
            GROUP BY week_number
            ORDER BY week_number
        `;
        const weekResult = await db.query(weekQuery, [userId, monthStart]);

        // 3. Get category breakdown
        const categoryQuery = `
            SELECT 
                c.id as category_id,
                c.category_name,
                COUNT(e.id) as expense_count,
                COALESCE(SUM(e.amount), 0) as total_amount
            FROM personal_expense_categories c
            LEFT JOIN personal_expenses e 
                ON e.category_id = c.id 
                AND e.user_id = $1 
                AND get_month_start(e.expense_date) = $2::DATE
            WHERE c.user_id = $1
            GROUP BY c.id, c.category_name
            ORDER BY total_amount DESC
        `;
        const categoryResult = await db.query(categoryQuery, [userId, monthStart]);

        // 4. Get all expense details
        const expenseQuery = `
            SELECT 
                e.id,
                e.amount,
                e.expense_date,
                e.notes,
                e.payment_method,
                e.is_recurring,
                e.created_at,
                e.updated_at,
                c.id as category_id,
                c.category_name,
                get_expense_week(e.expense_date) as week_number
            FROM personal_expenses e
            JOIN personal_expense_categories c ON e.category_id = c.id
            WHERE e.user_id = $1 
            AND get_month_start(e.expense_date) = $2::DATE
            ORDER BY e.expense_date DESC, e.created_at DESC
        `;
        const expenseResult = await db.query(expenseQuery, [userId, monthStart]);

        // Format dates in response
        const expenses = expenseResult.rows.map(row => ({
            ...row,
            icon: row.icon || "📊",
            color: row.color || "#3B82F6",
            expense_date: formatDate(row.expense_date),
            amount: parseFloat(row.amount)
        }));

        res.json({
            success: true,
            data: {
                month: {
                    start: monthStart,
                    display: formatMonthDisplay(monthStart)
                },
                summary: {
                    total_expenses: totalExpenses,
                    expense_count: expenses.length,
                    weekly_breakdown: weekResult.rows.map(row => ({
                        week_number: parseInt(row.week_number),
                        expense_count: parseInt(row.expense_count),
                        total_amount: parseFloat(row.total_amount)
                    })),
                    category_breakdown: categoryResult.rows.map(row => ({
                        category_id: row.category_id,
                        category_name: row.category_name,
                        icon: "📊",
                        color: "#3B82F6",
                        expense_count: parseInt(row.expense_count),
                        total_amount: parseFloat(row.total_amount)
                    }))
                },
                expenses: expenses
            }
        });

    } catch (error) {
        console.error("Error fetching expenses:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// GET - Get single expense by ID
router.get("/:id", authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const expenseId = req.params.id;

        const query = `
            SELECT 
                e.id,
                e.amount,
                e.expense_date,
                e.notes,
                e.payment_method,
                e.is_recurring,
                e.created_at,
                e.updated_at,
                c.id as category_id,
                c.category_name,
                get_expense_week(e.expense_date) as week_number
            FROM personal_expenses e
            JOIN personal_expense_categories c ON e.category_id = c.id
            WHERE e.id = $1 AND e.user_id = $2
        `;

        const result = await db.query(query, [expenseId, userId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Expense not found" });
        }

        const expense = {
            ...result.rows[0],
            icon: result.rows[0].icon || "📊",
            color: result.rows[0].color || "#3B82F6",
            expense_date: formatDate(result.rows[0].expense_date),
            amount: parseFloat(result.rows[0].amount)
        };

        res.json({
            success: true,
            data: expense
        });

    } catch (error) {
        console.error("Error fetching expense:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// POST - Add new expense
router.post("/", authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { 
            category_id,
            amount,
            expense_date,
            notes = '',
            payment_method = 'cash',
            is_recurring = false
        } = req.body;

        // Validation
        if (!category_id) {
            return res.status(400).json({ error: "Category is required" });
        }

        if (!amount || amount <= 0) {
            return res.status(400).json({ error: "Amount must be greater than 0" });
        }

        if (!expense_date) {
            return res.status(400).json({ error: "Expense date is required" });
        }

        // Check if category exists and belongs to user
        const categoryCheck = `
            SELECT id FROM personal_expense_categories
            WHERE id = $1 AND user_id = $2
        `;
        const categoryResult = await db.query(categoryCheck, [category_id, userId]);

        if (categoryResult.rows.length === 0) {
            return res.status(400).json({ error: "Invalid category" });
        }

        // Format expense date
        const formattedDate = formatDate(expense_date);

        const query = `
            INSERT INTO personal_expenses (
                user_id,
                category_id,
                amount,
                expense_date,
                notes,
                payment_method,
                is_recurring
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING *
        `;

        const result = await db.query(query, [
            userId,
            category_id,
            amount,
            formattedDate,
            notes,
            payment_method,
            is_recurring
        ]);

        res.json({
            success: true,
            message: "Expense added successfully",
            data: {
                ...result.rows[0],
                expense_date: formatDate(result.rows[0].expense_date),
                amount: parseFloat(result.rows[0].amount)
            }
        });

    } catch (error) {
        console.error("Error adding expense:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// PUT - Update expense
router.put("/:id", authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const expenseId = req.params.id;
        const { 
            category_id,
            amount,
            expense_date,
            notes,
            payment_method,
            is_recurring
        } = req.body;

        // Check if expense exists and belongs to user
        const checkQuery = `
            SELECT id FROM personal_expenses
            WHERE id = $1 AND user_id = $2
        `;
        const checkResult = await db.query(checkQuery, [expenseId, userId]);

        if (checkResult.rows.length === 0) {
            return res.status(404).json({ error: "Expense not found" });
        }

        // Build dynamic update query
        const updates = [];
        const values = [];
        let paramCount = 1;

        if (category_id !== undefined) {
            // Verify category belongs to user
            const catCheck = `
                SELECT id FROM personal_expense_categories
                WHERE id = $1 AND user_id = $2
            `;
            const catResult = await db.query(catCheck, [category_id, userId]);
            if (catResult.rows.length === 0) {
                return res.status(400).json({ error: "Invalid category" });
            }
            updates.push(`category_id = $${paramCount}`);
            values.push(category_id);
            paramCount++;
        }

        if (amount !== undefined) {
            if (amount <= 0) {
                return res.status(400).json({ error: "Amount must be greater than 0" });
            }
            updates.push(`amount = $${paramCount}`);
            values.push(amount);
            paramCount++;
        }

        if (expense_date !== undefined) {
            const formattedDate = formatDate(expense_date);
            updates.push(`expense_date = $${paramCount}`);
            values.push(formattedDate);
            paramCount++;
        }

        if (notes !== undefined) {
            updates.push(`notes = $${paramCount}`);
            values.push(notes);
            paramCount++;
        }

        if (payment_method !== undefined) {
            updates.push(`payment_method = $${paramCount}`);
            values.push(payment_method);
            paramCount++;
        }

        if (is_recurring !== undefined) {
            updates.push(`is_recurring = $${paramCount}`);
            values.push(is_recurring);
            paramCount++;
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: "No fields to update" });
        }

        values.push(expenseId, userId);

        const query = `
            UPDATE personal_expenses
            SET ${updates.join(', ')}
            WHERE id = $${paramCount} AND user_id = $${paramCount + 1}
            RETURNING *
        `;

        const result = await db.query(query, values);

        res.json({
            success: true,
            message: "Expense updated successfully",
            data: {
                ...result.rows[0],
                expense_date: formatDate(result.rows[0].expense_date),
                amount: parseFloat(result.rows[0].amount)
            }
        });

    } catch (error) {
        console.error("Error updating expense:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// DELETE - Delete expense
router.delete("/:id", authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const expenseId = req.params.id;

        const query = `
            DELETE FROM personal_expenses
            WHERE id = $1 AND user_id = $2
            RETURNING *
        `;

        const result = await db.query(query, [expenseId, userId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Expense not found" });
        }

        res.json({
            success: true,
            message: "Expense deleted successfully",
            data: {
                ...result.rows[0],
                expense_date: formatDate(result.rows[0].expense_date),
                amount: parseFloat(result.rows[0].amount)
            }
        });

    } catch (error) {
        console.error("Error deleting expense:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// ==================== EXPORT ROUTER ====================
module.exports = router;