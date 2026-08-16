// routes/expenseApi.js
// Expense API - complete CRUD + weekly/monthly/category calculations
// PostgreSQL + Express + JWT

const express = require("express");
const jwt = require("jsonwebtoken");

const router = express.Router();
const db = require("../db.js");

const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key";

// ============================================================
// AUTH
// ============================================================

const authenticate = (req, res, next) => {
  try {
    const header = req.headers.authorization || "";

    if (!header.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Authentication token required",
      });
    }

    const token = header.substring(7);
    const decoded = jwt.verify(token, JWT_SECRET);

    if (!decoded?.id) {
      return res.status(401).json({
        success: false,
        message: "Invalid authentication token",
      });
    }

    req.userId = Number(decoded.id);
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired authentication token",
    });
  }
};

// ============================================================
// HELPERS
// ============================================================

const getCurrentMonth = () => {
  const now = new Date();

  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
};

const getMonthRange = (month) => {
  if (!/^\d{4}-\d{2}$/.test(month || "")) {
    return null;
  }

  const [year, monthNumber] = month.split("-").map(Number);

  if (monthNumber < 1 || monthNumber > 12) {
    return null;
  }

  const monthStart =
    `${year}-${String(monthNumber).padStart(2, "0")}-01`;

  const nextYear =
    monthNumber === 12 ? year + 1 : year;

  const nextMonth =
    monthNumber === 12 ? 1 : monthNumber + 1;

  const nextMonthStart =
    `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`;

  const lastDay =
    new Date(Date.UTC(year, monthNumber, 0))
      .toISOString()
      .slice(0, 10);

  return {
    monthStart,
    nextMonthStart,
    lastDay,
  };
};

const isValidDate = (value) => {
  if (!value || typeof value !== "string") {
    return false;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00Z`);

  return !Number.isNaN(date.getTime());
};

const isValidMonth = (month) => {
  return Boolean(getMonthRange(month));
};

const parseAmount = (value) => {
  const amount = Number(value);

  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }

  return amount;
};

// ============================================================
// WEEK CALCULATION
//
// Week 1 = days 1-7
// Week 2 = days 8-14
// Week 3 = days 15-21
// Week 4 = days 22-28
// Week 5 = days 29-end of month
//
// This keeps weekly expense reporting consistent.
// ============================================================

const getWeekNumber = (dateString) => {
  const day = Number(dateString.slice(8, 10));

  if (day <= 7) return 1;
  if (day <= 14) return 2;
  if (day <= 21) return 3;
  if (day <= 28) return 4;

  return 5;
};

// ============================================================
// CREATE TABLE + INDEXES
// ============================================================

const createTable = async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS personal_expenses (
        id SERIAL PRIMARY KEY,

        user_id INTEGER NOT NULL
          REFERENCES personal_users(id)
          ON DELETE CASCADE,

        category VARCHAR(100) NOT NULL,

        amount NUMERIC(15,2) NOT NULL,

        expense_date DATE NOT NULL DEFAULT CURRENT_DATE,

        notes TEXT,

        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

        CONSTRAINT chk_expense_amount
          CHECK (amount > 0)
      )
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_expenses_user_date
      ON personal_expenses(user_id, expense_date)
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_expenses_user_category
      ON personal_expenses(user_id, category)
    `);

    console.log("✅ Personal expenses table ready");
  } catch (error) {
    console.error(
      "❌ Expense table setup error:",
      error.message
    );
  }
};

createTable();

// ============================================================
// 1. CREATE EXPENSE
// POST /api/expenses
//
// User can select an expense date only inside the selected month.
// Backend verifies that the date belongs to the requested month.
// ============================================================

router.post("/", authenticate, async (req, res) => {
  try {
    const {
      category,
      amount,
      expense_date,
      notes,
      month,
    } = req.body;

    if (!category || !String(category).trim()) {
      return res.status(400).json({
        success: false,
        message: "Expense category is required",
      });
    }

    const numericAmount = parseAmount(amount);

    if (numericAmount === null) {
      return res.status(400).json({
        success: false,
        message: "Amount must be greater than 0",
      });
    }

    const selectedMonth = month || getCurrentMonth();
    const range = getMonthRange(selectedMonth);

    if (!range) {
      return res.status(400).json({
        success: false,
        message: "Invalid month. Use YYYY-MM.",
      });
    }

    const date =
      expense_date ||
      new Date().toISOString().slice(0, 10);

    if (!isValidDate(date)) {
      return res.status(400).json({
        success: false,
        message: "Invalid expense date",
      });
    }

    // Expense must belong to selected month.
    if (
      date < range.monthStart ||
      date >= range.nextMonthStart
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Expense date must belong to the selected month",
      });
    }

    const result = await db.query(
      `
      INSERT INTO personal_expenses (
        user_id,
        category,
        amount,
        expense_date,
        notes
      )
      VALUES ($1,$2,$3,$4,$5)
      RETURNING *
      `,
      [
        req.userId,
        String(category).trim(),
        numericAmount,
        date,
        notes || null,
      ]
    );

    const created = result.rows[0];

    return res.status(201).json({
      success: true,
      message: "Expense added successfully",
      data: {
        ...created,
        week: getWeekNumber(created.expense_date),
      },
    });
  } catch (error) {
    console.error("❌ Create expense error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to add expense",
      error: error.message,
    });
  }
});

// ============================================================
// 2. GET ALL EXPENSES
// GET /api/expenses?month=2026-08&category=Food&week=2
// ============================================================

router.get("/", authenticate, async (req, res) => {
  try {
    const month = req.query.month || getCurrentMonth();
    const category = req.query.category;
    const week = req.query.week
      ? Number(req.query.week)
      : null;

    const range = getMonthRange(month);

    if (!range) {
      return res.status(400).json({
        success: false,
        message: "Invalid month. Use YYYY-MM.",
      });
    }

    if (
      week !== null &&
      (!Number.isInteger(week) || week < 1 || week > 5)
    ) {
      return res.status(400).json({
        success: false,
        message: "Week must be between 1 and 5",
      });
    }

    let query = `
      SELECT
        id,
        category,
        amount,
        expense_date,
        notes,
        created_at
      FROM personal_expenses
      WHERE user_id = $1
        AND expense_date >= $2::DATE
        AND expense_date < $3::DATE
    `;

    const values = [
      req.userId,
      range.monthStart,
      range.nextMonthStart,
    ];

    let index = 4;

    if (category) {
      query += ` AND LOWER(category) = LOWER($${index})`;
      values.push(String(category).trim());
      index++;
    }

    if (week !== null) {
      const weekStartDay =
        week === 1 ? 1 :
        week === 2 ? 8 :
        week === 3 ? 15 :
        week === 4 ? 22 :
        29;

      const weekEndDay =
        week === 1 ? 8 :
        week === 2 ? 15 :
        week === 3 ? 22 :
        week === 4 ? 29 :
        null;

      query += `
        AND EXTRACT(DAY FROM expense_date) >= ${weekStartDay}
      `;

      if (weekEndDay) {
        query += `
          AND EXTRACT(DAY FROM expense_date) < ${weekEndDay}
        `;
      }
    }

    query += `
      ORDER BY expense_date DESC, id DESC
    `;

    const result = await db.query(query, values);

    const data = result.rows.map((row) => ({
      ...row,
      week: getWeekNumber(row.expense_date),
    }));

    return res.json({
      success: true,
      month,
      count: data.length,
      data,
    });
  } catch (error) {
    console.error("❌ Get expenses error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch expenses",
      error: error.message,
    });
  }
});

// ============================================================
// 3. GET SINGLE EXPENSE
// GET /api/expenses/:id
// ============================================================

router.get("/:id", authenticate, async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid expense ID",
      });
    }

    const result = await db.query(
      `
      SELECT
        id,
        category,
        amount,
        expense_date,
        notes,
        created_at
      FROM personal_expenses
      WHERE id = $1
        AND user_id = $2
      `,
      [id, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Expense not found",
      });
    }

    const expense = result.rows[0];

    return res.json({
      success: true,
      data: {
        ...expense,
        week: getWeekNumber(expense.expense_date),
      },
    });
  } catch (error) {
    console.error("❌ Get single expense error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch expense",
      error: error.message,
    });
  }
});

// ============================================================
// 4. UPDATE EXPENSE
// PUT /api/expenses/:id
// ============================================================

router.put("/:id", authenticate, async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid expense ID",
      });
    }

    const existing = await db.query(
      `
      SELECT *
      FROM personal_expenses
      WHERE id = $1
        AND user_id = $2
      `,
      [id, req.userId]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Expense not found",
      });
    }

    const old = existing.rows[0];

    const {
      category,
      amount,
      expense_date,
      notes,
      month,
    } = req.body;

    const finalCategory =
      category !== undefined
        ? String(category).trim()
        : old.category;

    const finalAmount =
      amount !== undefined
        ? parseAmount(amount)
        : Number(old.amount);

    const finalDate =
      expense_date !== undefined
        ? expense_date
        : old.expense_date;

    if (!finalCategory) {
      return res.status(400).json({
        success: false,
        message: "Expense category is required",
      });
    }

    if (finalAmount === null || finalAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Amount must be greater than 0",
      });
    }

    if (!isValidDate(String(finalDate))) {
      return res.status(400).json({
        success: false,
        message: "Invalid expense date",
      });
    }

    // If month is provided, date must stay in that selected month.
    // Otherwise use the month of the final expense date.
    const selectedMonth =
      month ||
      String(finalDate).slice(0, 7);

    const range = getMonthRange(selectedMonth);

    if (!range) {
      return res.status(400).json({
        success: false,
        message: "Invalid month. Use YYYY-MM.",
      });
    }

    if (
      finalDate < range.monthStart ||
      finalDate >= range.nextMonthStart
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Expense date must belong to the selected month",
      });
    }

    const finalNotes =
      notes !== undefined
        ? notes
        : old.notes;

    const result = await db.query(
      `
      UPDATE personal_expenses
      SET
        category = $1,
        amount = $2,
        expense_date = $3,
        notes = $4
      WHERE id = $5
        AND user_id = $6
      RETURNING *
      `,
      [
        finalCategory,
        finalAmount,
        finalDate,
        finalNotes || null,
        id,
        req.userId,
      ]
    );

    const updated = result.rows[0];

    return res.json({
      success: true,
      message: "Expense updated successfully",
      data: {
        ...updated,
        week: getWeekNumber(updated.expense_date),
      },
    });
  } catch (error) {
    console.error("❌ Update expense error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to update expense",
      error: error.message,
    });
  }
});

// ============================================================
// 5. DELETE EXPENSE
// DELETE /api/expenses/:id
// ============================================================

router.delete("/:id", authenticate, async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid expense ID",
      });
    }

    const result = await db.query(
      `
      DELETE FROM personal_expenses
      WHERE id = $1
        AND user_id = $2
      RETURNING *
      `,
      [id, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Expense not found",
      });
    }

    return res.json({
      success: true,
      message: "Expense deleted successfully",
      data: result.rows[0],
    });
  } catch (error) {
    console.error("❌ Delete expense error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to delete expense",
      error: error.message,
    });
  }
});

// ============================================================
// 6. MONTHLY SUMMARY
// GET /api/expenses/monthly-summary?month=2026-08
//
// Returns:
// - Total month expense
// - Week 1-5 totals
// - Category totals
// - Category + weekly breakdown
// ============================================================

router.get("/monthly-summary", authenticate, async (req, res) => {
  try {
    const month = req.query.month || getCurrentMonth();
    const range = getMonthRange(month);

    if (!range) {
      return res.status(400).json({
        success: false,
        message: "Invalid month. Use YYYY-MM.",
      });
    }

    // Weekly totals.
    const weeklyResult = await db.query(
      `
      SELECT
        CASE
          WHEN EXTRACT(DAY FROM expense_date) BETWEEN 1 AND 7 THEN 1
          WHEN EXTRACT(DAY FROM expense_date) BETWEEN 8 AND 14 THEN 2
          WHEN EXTRACT(DAY FROM expense_date) BETWEEN 15 AND 21 THEN 3
          WHEN EXTRACT(DAY FROM expense_date) BETWEEN 22 AND 28 THEN 4
          ELSE 5
        END AS week,

        COALESCE(SUM(amount), 0) AS total

      FROM personal_expenses

      WHERE user_id = $1
        AND expense_date >= $2::DATE
        AND expense_date < $3::DATE

      GROUP BY week
      ORDER BY week
      `,
      [
        req.userId,
        range.monthStart,
        range.nextMonthStart,
      ]
    );

    // Category totals.
    const categoryResult = await db.query(
      `
      SELECT
        category,
        COALESCE(SUM(amount), 0) AS total,
        COUNT(*)::INTEGER AS count

      FROM personal_expenses

      WHERE user_id = $1
        AND expense_date >= $2::DATE
        AND expense_date < $3::DATE

      GROUP BY category
      ORDER BY total DESC, category ASC
      `,
      [
        req.userId,
        range.monthStart,
        range.nextMonthStart,
      ]
    );

    // Category + week combined breakdown.
    const categoryWeekResult = await db.query(
      `
      SELECT
        category,

        COALESCE(
          SUM(
            CASE
              WHEN EXTRACT(DAY FROM expense_date) BETWEEN 1 AND 7
              THEN amount ELSE 0
            END
          ),
          0
        ) AS week_1,

        COALESCE(
          SUM(
            CASE
              WHEN EXTRACT(DAY FROM expense_date) BETWEEN 8 AND 14
              THEN amount ELSE 0
            END
          ),
          0
        ) AS week_2,

        COALESCE(
          SUM(
            CASE
              WHEN EXTRACT(DAY FROM expense_date) BETWEEN 15 AND 21
              THEN amount ELSE 0
            END
          ),
          0
        ) AS week_3,

        COALESCE(
          SUM(
            CASE
              WHEN EXTRACT(DAY FROM expense_date) BETWEEN 22 AND 28
              THEN amount ELSE 0
            END
          ),
          0
        ) AS week_4,

        COALESCE(
          SUM(
            CASE
              WHEN EXTRACT(DAY FROM expense_date) >= 29
              THEN amount ELSE 0
            END
          ),
          0
        ) AS week_5,

        COALESCE(SUM(amount), 0) AS total

      FROM personal_expenses

      WHERE user_id = $1
        AND expense_date >= $2::DATE
        AND expense_date < $3::DATE

      GROUP BY category

      ORDER BY total DESC, category ASC
      `,
      [
        req.userId,
        range.monthStart,
        range.nextMonthStart,
      ]
    );

    const totalResult = await db.query(
      `
      SELECT
        COALESCE(SUM(amount), 0) AS total,
        COUNT(*)::INTEGER AS count
      FROM personal_expenses
      WHERE user_id = $1
        AND expense_date >= $2::DATE
        AND expense_date < $3::DATE
      `,
      [
        req.userId,
        range.monthStart,
        range.nextMonthStart,
      ]
    );

    const weekMap = new Map(
      weeklyResult.rows.map((row) => [
        Number(row.week),
        Number(row.total),
      ])
    );

    const weekly = [1, 2, 3, 4, 5].map((week) => ({
      week,
      total: weekMap.get(week) || 0,
    }));

    return res.json({
      success: true,
      month,

      total: Number(totalResult.rows[0].total || 0),
      count: Number(totalResult.rows[0].count || 0),

      weekly,

      categories: categoryResult.rows.map((row) => ({
        category: row.category,
        total: Number(row.total || 0),
        count: Number(row.count || 0),
      })),

      category_weekly: categoryWeekResult.rows.map((row) => ({
        category: row.category,
        week_1: Number(row.week_1 || 0),
        week_2: Number(row.week_2 || 0),
        week_3: Number(row.week_3 || 0),
        week_4: Number(row.week_4 || 0),
        week_5: Number(row.week_5 || 0),
        total: Number(row.total || 0),
      })),
    });
  } catch (error) {
    console.error("❌ Monthly expense summary error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to calculate monthly expense summary",
      error: error.message,
    });
  }
});

// ============================================================
// 7. WEEKLY SUMMARY
// GET /api/expenses/weekly-summary?month=2026-08&week=1
// ============================================================

router.get("/weekly-summary", authenticate, async (req, res) => {
  try {
    const month = req.query.month || getCurrentMonth();
    const week = Number(req.query.week);

    const range = getMonthRange(month);

    if (!range) {
      return res.status(400).json({
        success: false,
        message: "Invalid month. Use YYYY-MM.",
      });
    }

    if (
      !Number.isInteger(week) ||
      week < 1 ||
      week > 5
    ) {
      return res.status(400).json({
        success: false,
        message: "Week must be between 1 and 5",
      });
    }

    const weekStartDay =
      week === 1 ? 1 :
      week === 2 ? 8 :
      week === 3 ? 15 :
      week === 4 ? 22 :
      29;

    const weekEndDay =
      week === 1 ? 8 :
      week === 2 ? 15 :
      week === 3 ? 22 :
      week === 4 ? 29 :
      null;

    let dateCondition = `
      AND EXTRACT(DAY FROM expense_date) >= ${weekStartDay}
    `;

    if (weekEndDay) {
      dateCondition += `
        AND EXTRACT(DAY FROM expense_date) < ${weekEndDay}
      `;
    }

    const totalResult = await db.query(
      `
      SELECT
        COALESCE(SUM(amount), 0) AS total,
        COUNT(*)::INTEGER AS count

      FROM personal_expenses

      WHERE user_id = $1
        AND expense_date >= $2::DATE
        AND expense_date < $3::DATE

        ${dateCondition}
      `,
      [
        req.userId,
        range.monthStart,
        range.nextMonthStart,
      ]
    );

    const categoryResult = await db.query(
      `
      SELECT
        category,
        COALESCE(SUM(amount), 0) AS total,
        COUNT(*)::INTEGER AS count

      FROM personal_expenses

      WHERE user_id = $1
        AND expense_date >= $2::DATE
        AND expense_date < $3::DATE

        ${dateCondition}

      GROUP BY category
      ORDER BY total DESC, category ASC
      `,
      [
        req.userId,
        range.monthStart,
        range.nextMonthStart,
      ]
    );

    return res.json({
      success: true,

      month,
      week,

      total: Number(totalResult.rows[0].total || 0),
      count: Number(totalResult.rows[0].count || 0),

      categories: categoryResult.rows.map((row) => ({
        category: row.category,
        total: Number(row.total || 0),
        count: Number(row.count || 0),
      })),
    });
  } catch (error) {
    console.error("❌ Weekly expense summary error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to calculate weekly expense summary",
      error: error.message,
    });
  }
});

// ============================================================
// 8. CATEGORY SUMMARY
// GET /api/expenses/category-summary?month=2026-08
// ============================================================

router.get("/category-summary", authenticate, async (req, res) => {
  try {
    const month = req.query.month || getCurrentMonth();
    const range = getMonthRange(month);

    if (!range) {
      return res.status(400).json({
        success: false,
        message: "Invalid month. Use YYYY-MM.",
      });
    }

    const result = await db.query(
      `
      SELECT
        category,
        COALESCE(SUM(amount), 0) AS total,
        COUNT(*)::INTEGER AS count,
        MIN(expense_date) AS first_expense_date,
        MAX(expense_date) AS last_expense_date

      FROM personal_expenses

      WHERE user_id = $1
        AND expense_date >= $2::DATE
        AND expense_date < $3::DATE

      GROUP BY category

      ORDER BY total DESC, category ASC
      `,
      [
        req.userId,
        range.monthStart,
        range.nextMonthStart,
      ]
    );

    return res.json({
      success: true,
      month,
      count: result.rows.length,

      data: result.rows.map((row) => ({
        category: row.category,
        total: Number(row.total || 0),
        count: Number(row.count || 0),
        first_expense_date: row.first_expense_date,
        last_expense_date: row.last_expense_date,
      })),
    });
  } catch (error) {
    console.error("❌ Category summary error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to calculate category summary",
      error: error.message,
    });
  }
});

// ============================================================
// 9. CURRENT MONTH TOTAL
// GET /api/expenses/current-month
// ============================================================

router.get("/current-month", authenticate, async (req, res) => {
  try {
    const month = getCurrentMonth();
    const range = getMonthRange(month);

    const result = await db.query(
      `
      SELECT
        COALESCE(SUM(amount), 0) AS total,
        COUNT(*)::INTEGER AS count
      FROM personal_expenses
      WHERE user_id = $1
        AND expense_date >= $2::DATE
        AND expense_date < $3::DATE
      `,
      [
        req.userId,
        range.monthStart,
        range.nextMonthStart,
      ]
    );

    return res.json({
      success: true,
      month,
      total: Number(result.rows[0].total || 0),
      count: Number(result.rows[0].count || 0),
    });
  } catch (error) {
    console.error("❌ Current month expense error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to load current month expense",
      error: error.message,
    });
  }
});

// ============================================================
// 10. AVAILABLE CATEGORIES
// GET /api/expenses/categories
//
// Returns categories already used by the user.
// Frontend can also provide its standard categories.
// ============================================================

router.get("/categories", authenticate, async (req, res) => {
  try {
    const result = await db.query(
      `
      SELECT DISTINCT category
      FROM personal_expenses
      WHERE user_id = $1
      ORDER BY category ASC
      `,
      [req.userId]
    );

    return res.json({
      success: true,
      data: result.rows.map((row) => row.category),
    });
  } catch (error) {
    console.error("❌ Expense categories error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to load expense categories",
      error: error.message,
    });
  }
});

// ============================================================
// EXPORT
// ============================================================

module.exports = router;