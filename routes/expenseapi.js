const express = require("express");
const jwt = require("jsonwebtoken");
const router = express.Router();
const db = require("../db");

const DEFAULT_CATEGORIES = [
  "Petrol",
  "Daily Kharch Saman",
  "Shopping",
  "Food",
  "Travel",
  "Bike",
  "Business",
];

const getJwtSecret = () =>
  process.env.JWT_SECRET ||
  process.env.JWT_SECRET_KEY ||
  process.env.ACCESS_TOKEN_SECRET ||
  process.env.AUTH_SECRET;

const getUserId = (req) => {
  // Supports existing auth middleware first.
  const existingId =
    req.userId ??
    req.user?.id ??
    req.user?.userId ??
    req.auth?.id ??
    req.auth?.userId;

  if (existingId !== undefined && existingId !== null) {
    const id = Number(existingId);
    return Number.isInteger(id) && id > 0 ? id : null;
  }

  // Login stores JWT as localStorage "token".
  // Expense.jsx must send: Authorization: Bearer <token>
  const header = String(req.headers.authorization || "");

  if (!header.startsWith("Bearer ")) return null;

  const token = header.slice(7).trim();
  const secret = getJwtSecret();

  if (!token || !secret) return null;

  try {
    const decoded = jwt.verify(token, secret);

    const rawId =
      decoded?.userId ??
      decoded?.id ??
      decoded?.user?.id ??
      decoded?.sub;

    const id = Number(rawId);

    return Number.isInteger(id) && id > 0 ? id : null;
  } catch (error) {
    console.error("Expense JWT error:", error.message);
    return null;
  }
};

const requireUser = (req, res, next) => {
  const userId = getUserId(req);

  if (!userId) {
    return res.status(401).json({
      success: false,
      message: "User authentication required.",
    });
  }

  req.userId = userId;
  next();
};

const normalizeAmount = (value) => {
  const amount = Number(value);

  if (!Number.isFinite(amount) || amount <= 0) return null;

  return Math.round((amount + Number.EPSILON) * 100) / 100;
};

const validDate = (value) =>
  /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));

const validMonth = (value) =>
  /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value || ""));

const currentMonth = () => {
  const d = new Date();

  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
    2,
    "0"
  )}`;
};

const today = () => {
  const d = new Date();

  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
    2,
    "0"
  )}-${String(d.getDate()).padStart(2, "0")}`;
};

const monthRange = (month) => {
  const [year, monthNo] = month.split("-").map(Number);

  const start = `${year}-${String(monthNo).padStart(2, "0")}-01`;

  const next =
    monthNo === 12
      ? `${year + 1}-01-01`
      : `${year}-${String(monthNo + 1).padStart(2, "0")}-01`;

  return { start, next };
};

const weekRange = (month, week) => {
  const [year, monthNo] = month.split("-").map(Number);

  if (!Number.isInteger(week) || week < 1 || week > 5) return null;

  const startDay = (week - 1) * 7 + 1;
  const daysInMonth = new Date(year, monthNo, 0).getDate();

  if (startDay > daysInMonth) return null;

  const endDay = Math.min(startDay + 6, daysInMonth);

  return {
    start: `${year}-${String(monthNo).padStart(2, "0")}-${String(
      startDay
    ).padStart(2, "0")}`,
    end: `${year}-${String(monthNo).padStart(2, "0")}-${String(
      endDay
    ).padStart(2, "0")}`,
  };
};

const uniqueCategories = (items) =>
  [...DEFAULT_CATEGORIES, ...items]
    .map((x) => String(x || "").trim())
    .filter(Boolean)
    .filter(
      (item, index, array) =>
        array.findIndex(
          (x) => x.toLowerCase() === item.toLowerCase()
        ) === index
    )
    .sort((a, b) => {
      const ai = DEFAULT_CATEGORIES.findIndex(
        (x) => x.toLowerCase() === a.toLowerCase()
      );
      const bi = DEFAULT_CATEGORIES.findIndex(
        (x) => x.toLowerCase() === b.toLowerCase()
      );

      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;

      return a.localeCompare(b);
    });

/*
|--------------------------------------------------------------------------
| GET categories
|--------------------------------------------------------------------------
*/

router.get("/categories", requireUser, async (req, res) => {
  try {
    const result = await db.query(
      `
      SELECT DISTINCT category
      FROM personal_expenses
      WHERE user_id = $1
        AND TRIM(category) <> ''
      ORDER BY category ASC
      `,
      [req.userId]
    );

    const categories = uniqueCategories(
      result.rows.map((row) => row.category)
    );

    res.json({
      success: true,
      categories,
      defaultCategories: DEFAULT_CATEGORIES,
    });
  } catch (error) {
    console.error("GET expense categories error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to load expense categories.",
    });
  }
});

/*
|--------------------------------------------------------------------------
| GET expenses
|--------------------------------------------------------------------------
| /api/expenses
| /api/expenses?month=2026-08
| /api/expenses?month=2026-08&week=1
|--------------------------------------------------------------------------
*/

router.get("/", requireUser, async (req, res) => {
  try {
    const userId = req.userId;
    const month = String(req.query.month || currentMonth());

    const week =
      req.query.week === undefined ||
      req.query.week === "" ||
      req.query.week === "all"
        ? null
        : Number(req.query.week);

    if (!validMonth(month)) {
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
        message: "Week must be between 1 and 5.",
      });
    }

    const { start, next } = monthRange(month);

    let query = `
      SELECT
        id,
        user_id,
        category,
        amount,
        expense_date,
        notes,
        created_at,
        updated_at
      FROM personal_expenses
      WHERE user_id = $1
        AND expense_date >= $2::DATE
        AND expense_date < $3::DATE
    `;

    const values = [userId, start, next];

    if (week !== null) {
      const range = weekRange(month, week);

      if (!range) {
        return res.json({
          success: true,
          month,
          selectedWeek: week,
          expenses: [],
          data: [],
          rows: [],
          summary: {
            monthTotal: 0,
            monthEntries: 0,
            selectedWeekTotal: 0,
            selectedWeekEntries: 0,
            categoryTotals: [],
            weekTotals: [],
          },
        });
      }

      query += `
        AND expense_date >= $4::DATE
        AND expense_date <= $5::DATE
      `;

      values.push(range.start, range.end);
    }

    query += `
      ORDER BY expense_date DESC, created_at DESC, id DESC
    `;

    const expensesResult = await db.query(query, values);

    const monthResult = await db.query(
      `
      SELECT
        COALESCE(SUM(amount), 0) AS total,
        COUNT(*)::INTEGER AS entries
      FROM personal_expenses
      WHERE user_id = $1
        AND expense_date >= $2::DATE
        AND expense_date < $3::DATE
      `,
      [userId, start, next]
    );

    const categoryResult = await db.query(
      `
      SELECT
        category,
        COALESCE(SUM(amount), 0) AS total,
        COUNT(*)::INTEGER AS entries
      FROM personal_expenses
      WHERE user_id = $1
        AND expense_date >= $2::DATE
        AND expense_date < $3::DATE
      GROUP BY category
      ORDER BY total DESC, category ASC
      `,
      [userId, start, next]
    );

    const weekTotalsResult = await db.query(
      `
      SELECT
        CASE
          WHEN EXTRACT(DAY FROM expense_date) BETWEEN 1 AND 7 THEN 1
          WHEN EXTRACT(DAY FROM expense_date) BETWEEN 8 AND 14 THEN 2
          WHEN EXTRACT(DAY FROM expense_date) BETWEEN 15 AND 21 THEN 3
          WHEN EXTRACT(DAY FROM expense_date) BETWEEN 22 AND 28 THEN 4
          ELSE 5
        END AS week,
        COALESCE(SUM(amount), 0) AS total,
        COUNT(*)::INTEGER AS entries
      FROM personal_expenses
      WHERE user_id = $1
        AND expense_date >= $2::DATE
        AND expense_date < $3::DATE
      GROUP BY 1
      ORDER BY 1
      `,
      [userId, start, next]
    );

    const expenses = expensesResult.rows;

    const selectedWeekTotal = expenses.reduce(
      (sum, item) => sum + Number(item.amount || 0),
      0
    );

    res.json({
      success: true,
      month,
      selectedWeek: week,

      expenses,
      data: expenses,
      rows: expenses,

      summary: {
        monthTotal: Number(monthResult.rows[0]?.total || 0),
        monthEntries: Number(monthResult.rows[0]?.entries || 0),

        selectedWeekTotal,
        selectedWeekEntries: expenses.length,

        categoryTotals: categoryResult.rows.map((row) => ({
          category: row.category,
          total: Number(row.total || 0),
          entries: Number(row.entries || 0),
        })),

        weekTotals: weekTotalsResult.rows.map((row) => ({
          week: Number(row.week),
          total: Number(row.total || 0),
          entries: Number(row.entries || 0),
        })),
      },
    });
  } catch (error) {
    console.error("GET expenses error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to load expenses.",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

/*
|--------------------------------------------------------------------------
| GET monthly summary
|--------------------------------------------------------------------------
*/

router.get("/summary", requireUser, async (req, res) => {
  try {
    const month = String(req.query.month || currentMonth());

    if (!validMonth(month)) {
      return res.status(400).json({
        success: false,
        message: "Invalid month. Use YYYY-MM.",
      });
    }

    const { start, next } = monthRange(month);

    const result = await db.query(
      `
      SELECT
        COALESCE(SUM(amount), 0) AS total,
        COUNT(*)::INTEGER AS entries,
        COUNT(DISTINCT category)::INTEGER AS categories
      FROM personal_expenses
      WHERE user_id = $1
        AND expense_date >= $2::DATE
        AND expense_date < $3::DATE
      `,
      [req.userId, start, next]
    );

    res.json({
      success: true,
      month,
      summary: {
        total: Number(result.rows[0]?.total || 0),
        entries: Number(result.rows[0]?.entries || 0),
        categories: Number(result.rows[0]?.categories || 0),
      },
    });
  } catch (error) {
    console.error("GET expense summary error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to load expense summary.",
    });
  }
});

/*
|--------------------------------------------------------------------------
| POST add expense
|--------------------------------------------------------------------------
*/

router.post("/", requireUser, async (req, res) => {
  try {
    const category = String(req.body.category || "").trim();
    const amount = normalizeAmount(req.body.amount);
    const expenseDate = String(
      req.body.expenseDate || today()
    );
    const notes =
      req.body.notes === null ||
      req.body.notes === undefined
        ? null
        : String(req.body.notes).trim() || null;

    if (!category) {
      return res.status(400).json({
        success: false,
        message: "Expense category is required.",
      });
    }

    if (category.length > 100) {
      return res.status(400).json({
        success: false,
        message: "Category cannot exceed 100 characters.",
      });
    }

    if (amount === null) {
      return res.status(400).json({
        success: false,
        message: "Amount must be greater than 0.",
      });
    }

    if (!validDate(expenseDate)) {
      return res.status(400).json({
        success: false,
        message: "Invalid expense date. Use YYYY-MM-DD.",
      });
    }

    const result = await db.query(
      `
      INSERT INTO personal_expenses (
        user_id,
        category,
        amount,
        expense_date,
        notes,
        created_at,
        updated_at
      )
      VALUES (
        $1,
        $2,
        $3,
        $4::DATE,
        $5,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      )
      RETURNING
        id,
        user_id,
        category,
        amount,
        expense_date,
        notes,
        created_at,
        updated_at
      `,
      [
        req.userId,
        category,
        amount,
        expenseDate,
        notes,
      ]
    );

    res.status(201).json({
      success: true,
      message: "Expense added successfully.",
      expense: result.rows[0],
    });
  } catch (error) {
    console.error("POST expense error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to add expense.",
    });
  }
});

/*
|--------------------------------------------------------------------------
| PUT update expense
|--------------------------------------------------------------------------
*/

router.put("/:id", requireUser, async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid expense ID.",
      });
    }

    const category = String(req.body.category || "").trim();
    const amount = normalizeAmount(req.body.amount);

    const expenseDate =
      req.body.expenseDate === undefined ||
      req.body.expenseDate === null ||
      req.body.expenseDate === ""
        ? null
        : String(req.body.expenseDate);

    const notes =
      req.body.notes === null ||
      req.body.notes === undefined
        ? null
        : String(req.body.notes).trim() || null;

    if (!category) {
      return res.status(400).json({
        success: false,
        message: "Expense category is required.",
      });
    }

    if (amount === null) {
      return res.status(400).json({
        success: false,
        message: "Amount must be greater than 0.",
      });
    }

    if (expenseDate && !validDate(expenseDate)) {
      return res.status(400).json({
        success: false,
        message: "Invalid expense date. Use YYYY-MM-DD.",
      });
    }

    const result = await db.query(
      `
      UPDATE personal_expenses
      SET
        category = $1,
        amount = $2,
        expense_date = COALESCE($3::DATE, expense_date),
        notes = $4,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $5
        AND user_id = $6
      RETURNING
        id,
        user_id,
        category,
        amount,
        expense_date,
        notes,
        created_at,
        updated_at
      `,
      [
        category,
        amount,
        expenseDate,
        notes,
        id,
        req.userId,
      ]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Expense not found.",
      });
    }

    res.json({
      success: true,
      message: "Expense updated successfully.",
      expense: result.rows[0],
    });
  } catch (error) {
    console.error("PUT expense error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to update expense.",
    });
  }
});

/*
|--------------------------------------------------------------------------
| DELETE expense
|--------------------------------------------------------------------------
*/

router.delete("/:id", requireUser, async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid expense ID.",
      });
    }

    const result = await db.query(
      `
      DELETE FROM personal_expenses
      WHERE id = $1
        AND user_id = $2
      RETURNING
        id,
        category,
        amount,
        expense_date
      `,
      [id, req.userId]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Expense not found.",
      });
    }

    res.json({
      success: true,
      message: "Expense deleted successfully.",
      expense: result.rows[0],
    });
  } catch (error) {
    console.error("DELETE expense error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to delete expense.",
    });
  }
});

module.exports = router;