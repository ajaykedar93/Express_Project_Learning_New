// routes/paymentApi.js
// Payment API
// Complete CRUD + Pending/Received/Overdue/Lost + category + date difference
// PostgreSQL + Express + JWT

const express = require("express");
const jwt = require("jsonwebtoken");

const router = express.Router();
const db = require("../db.js");

const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key";

// ============================================================
// AUTHENTICATION
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

const getCurrentDate = () => {
  return new Date().toISOString().slice(0, 10);
};

const getCurrentMonth = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
};

const getMonthRange = (month) => {
  if (!/^\d{4}-\d{2}$/.test(month || "")) return null;

  const [year, monthNumber] = month.split("-").map(Number);

  if (monthNumber < 1 || monthNumber > 12) return null;

  const monthStart =
    `${year}-${String(monthNumber).padStart(2, "0")}-01`;

  const nextYear = monthNumber === 12 ? year + 1 : year;
  const nextMonth = monthNumber === 12 ? 1 : monthNumber + 1;

  const nextMonthStart =
    `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`;

  return { monthStart, nextMonthStart };
};

const isValidDate = (value) => {
  if (!value || typeof value !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime());
};

const parseAmount = (value) => {
  const amount = Number(value);

  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }

  return amount;
};

const normalizeCategory = (value) => {
  if (!value) return null;

  const category = String(value).trim().toLowerCase();

  if (category === "work") return "Work";
  if (category === "business") return "Business";
  if (category === "other") return "Other";

  return null;
};

const normalizeStatus = (value) => {
  if (!value) return "Pending";

  const status = String(value).trim().toLowerCase();

  if (status === "pending") return "Pending";
  if (status === "received") return "Received";
  if (status === "overdue") return "Overdue";
  if (status === "lost") return "Lost";

  return null;
};

// Difference is based on calendar dates.
// Example: payment_date 2026-08-10, received_date 2026-08-13 = 3 days.
const calculateDateDifference = (paymentDate, receivedDate) => {
  if (!paymentDate || !receivedDate) {
    return {
      difference_days: null,
      difference_months: null,
    };
  }

  const start = new Date(`${paymentDate}T00:00:00Z`);
  const end = new Date(`${receivedDate}T00:00:00Z`);

  const differenceDays = Math.max(
    0,
    Math.round(
      (end.getTime() - start.getTime()) /
      (1000 * 60 * 60 * 24)
    )
  );

  let months =
    (end.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    (end.getUTCMonth() - start.getUTCMonth());

  if (end.getUTCDate() < start.getUTCDate()) {
    months -= 1;
  }

  return {
    difference_days: differenceDays,
    difference_months: Math.max(0, months),
  };
};

const enrichPayment = (row) => {
  const receivedDate = row.received_at
    ? String(row.received_at).slice(0, 10)
    : null;

  const difference = calculateDateDifference(
    row.payment_date,
    receivedDate
  );

  return {
    ...row,
    amount: Number(row.amount || 0),
    received_date: receivedDate,
    ...difference,
  };
};

// ============================================================
// TABLE
// ============================================================

const createTable = async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS personal_payments (
        id SERIAL PRIMARY KEY,

        user_id INTEGER NOT NULL
          REFERENCES personal_users(id)
          ON DELETE CASCADE,

        person_name VARCHAR(150) NOT NULL,

        amount NUMERIC(15,2) NOT NULL,

        category VARCHAR(20) NOT NULL
          CHECK (category IN ('Work', 'Business', 'Other')),

        payment_date DATE NOT NULL DEFAULT CURRENT_DATE,

        received_at TIMESTAMP,

        status VARCHAR(20) NOT NULL DEFAULT 'Pending'
          CHECK (
            status IN (
              'Pending',
              'Received',
              'Overdue',
              'Lost'
            )
          ),

        notes TEXT,

        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

        CONSTRAINT chk_payment_amount
          CHECK (amount > 0),

        CONSTRAINT chk_received_status
          CHECK (
            (status = 'Received' AND received_at IS NOT NULL)
            OR
            (status <> 'Received')
          )
      )
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_personal_payments_user_date
      ON personal_payments(user_id, payment_date)
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_personal_payments_user_status
      ON personal_payments(user_id, status)
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_personal_payments_user_category
      ON personal_payments(user_id, category)
    `);

    console.log("✅ Personal payments table ready");
  } catch (error) {
    console.error(
      "❌ Payment table setup error:",
      error.message
    );
  }
};

createTable();

// ============================================================
// 1. CREATE PENDING PAYMENT
// POST /api/payments
//
// IMPORTANT:
// The user cannot select an old/future payment date.
// A new pending payment always uses CURRENT_DATE.
// ============================================================

router.post("/", authenticate, async (req, res) => {
  try {
    const {
      person_name,
      amount,
      category,
      notes,
    } = req.body;

    if (!person_name || !String(person_name).trim()) {
      return res.status(400).json({
        success: false,
        message: "Person name is required",
      });
    }

    const numericAmount = parseAmount(amount);

    if (numericAmount === null) {
      return res.status(400).json({
        success: false,
        message: "Amount must be greater than 0",
      });
    }

    const normalizedCategory = normalizeCategory(category);

    if (!normalizedCategory) {
      return res.status(400).json({
        success: false,
        message: "Category must be Work, Business or Other",
      });
    }

    const currentDate = getCurrentDate();

    const result = await db.query(
      `
      INSERT INTO personal_payments (
        user_id,
        person_name,
        amount,
        category,
        payment_date,
        status,
        notes
      )
      VALUES ($1,$2,$3,$4,$5,'Pending',$6)
      RETURNING *
      `,
      [
        req.userId,
        String(person_name).trim(),
        numericAmount,
        normalizedCategory,
        currentDate,
        notes || null,
      ]
    );

    return res.status(201).json({
      success: true,
      message: "Pending payment added successfully",
      data: enrichPayment(result.rows[0]),
    });
  } catch (error) {
    console.error("❌ Create payment error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to add payment",
      error: error.message,
    });
  }
});

// ============================================================
// 2. GET PAYMENTS
// GET /api/payments?month=2026-08&status=Pending&category=Work
//
// Selected month is used by the frontend.
// Default page size = 10.
// ============================================================

router.get("/", authenticate, async (req, res) => {
  try {
    const month = req.query.month || getCurrentMonth();
    const range = getMonthRange(month);

    if (!range) {
      return res.status(400).json({
        success: false,
        message: "Invalid month. Use YYYY-MM.",
      });
    }

    const status = req.query.status
      ? normalizeStatus(req.query.status)
      : null;

    const category = req.query.category
      ? normalizeCategory(req.query.category)
      : null;

    if (req.query.status && !status) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment status",
      });
    }

    if (req.query.category && !category) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment category",
      });
    }

    const page = Math.max(
      1,
      Number(req.query.page) || 1
    );

    const limit = Math.min(
      10,
      Math.max(1, Number(req.query.limit) || 10)
    );

    const offset = (page - 1) * limit;

    let where = `
      WHERE user_id = $1
        AND payment_date >= $2::DATE
        AND payment_date < $3::DATE
    `;

    const values = [
      req.userId,
      range.monthStart,
      range.nextMonthStart,
    ];

    let index = 4;

    if (status) {
      where += ` AND status = $${index}`;
      values.push(status);
      index++;
    }

    if (category) {
      where += ` AND category = $${index}`;
      values.push(category);
      index++;
    }

    const countResult = await db.query(
      `
      SELECT COUNT(*)::INTEGER AS total
      FROM personal_payments
      ${where}
      `,
      values
    );

    const result = await db.query(
      `
      SELECT *
      FROM personal_payments
      ${where}
      ORDER BY payment_date DESC, id DESC
      LIMIT $${index}
      OFFSET $${index + 1}
      `,
      [...values, limit, offset]
    );

    const total = Number(countResult.rows[0].total || 0);

    return res.json({
      success: true,
      month,

      pagination: {
        page,
        limit,
        total,
        total_pages: Math.ceil(total / limit),
        has_next: page < Math.ceil(total / limit),
        has_previous: page > 1,
      },

      data: result.rows.map(enrichPayment),
    });
  } catch (error) {
    console.error("❌ Get payments error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch payments",
      error: error.message,
    });
  }
});

// ============================================================
// 3. GET SINGLE PAYMENT
// GET /api/payments/:id
// ============================================================

router.get("/:id", authenticate, async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment ID",
      });
    }

    const result = await db.query(
      `
      SELECT *
      FROM personal_payments
      WHERE id = $1
        AND user_id = $2
      `,
      [id, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Payment not found",
      });
    }

    return res.json({
      success: true,
      data: enrichPayment(result.rows[0]),
    });
  } catch (error) {
    console.error("❌ Get payment error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch payment",
      error: error.message,
    });
  }
});

// ============================================================
// 4. UPDATE PENDING PAYMENT
// PUT /api/payments/:id
//
// Payment date is NEVER user-editable.
// Existing payment_date remains unchanged.
// ============================================================

router.put("/:id", authenticate, async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment ID",
      });
    }

    const existing = await db.query(
      `
      SELECT *
      FROM personal_payments
      WHERE id = $1
        AND user_id = $2
      `,
      [id, req.userId]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Payment not found",
      });
    }

    const old = existing.rows[0];

    if (old.status === "Received") {
      return res.status(400).json({
        success: false,
        message:
          "Received payment cannot be edited as a pending payment",
      });
    }

    const {
      person_name,
      amount,
      category,
      notes,
      status,
    } = req.body;

    const finalName =
      person_name !== undefined
        ? String(person_name).trim()
        : old.person_name;

    const finalAmount =
      amount !== undefined
        ? parseAmount(amount)
        : Number(old.amount);

    const finalCategory =
      category !== undefined
        ? normalizeCategory(category)
        : old.category;

    const finalStatus =
      status !== undefined
        ? normalizeStatus(status)
        : old.status;

    const finalNotes =
      notes !== undefined
        ? notes
        : old.notes;

    if (!finalName) {
      return res.status(400).json({
        success: false,
        message: "Person name is required",
      });
    }

    if (finalAmount === null) {
      return res.status(400).json({
        success: false,
        message: "Amount must be greater than 0",
      });
    }

    if (!finalCategory) {
      return res.status(400).json({
        success: false,
        message: "Invalid category",
      });
    }

    // Received status should be handled by the dedicated
    // /received endpoint so current date/time is always used.
    if (finalStatus === "Received") {
      return res.status(400).json({
        success: false,
        message:
          "Use the Received button/API to receive the payment",
      });
    }

    const result = await db.query(
      `
      UPDATE personal_payments
      SET
        person_name = $1,
        amount = $2,
        category = $3,
        status = $4,
        notes = $5,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $6
        AND user_id = $7
      RETURNING *
      `,
      [
        finalName,
        finalAmount,
        finalCategory,
        finalStatus,
        finalNotes || null,
        id,
        req.userId,
      ]
    );

    return res.json({
      success: true,
      message: "Payment updated successfully",
      data: enrichPayment(result.rows[0]),
    });
  } catch (error) {
    console.error("❌ Update payment error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to update payment",
      error: error.message,
    });
  }
});

// ============================================================
// 5. MARK PAYMENT AS RECEIVED
// PATCH /api/payments/:id/received
//
// Uses CURRENT server date/time.
// Calculates payment_date -> received_at difference.
// ============================================================

router.patch("/:id/received", authenticate, async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment ID",
      });
    }

    const result = await db.query(
      `
      UPDATE personal_payments
      SET
        status = 'Received',
        received_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
        AND user_id = $2
        AND status IN ('Pending', 'Overdue')
      RETURNING *
      `,
      [id, req.userId]
    );

    if (result.rows.length === 0) {
      const check = await db.query(
        `
        SELECT status
        FROM personal_payments
        WHERE id = $1
          AND user_id = $2
        `,
        [id, req.userId]
      );

      if (check.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Payment not found",
        });
      }

      return res.status(400).json({
        success: false,
        message:
          "Payment is already received or cannot be received",
      });
    }

    return res.json({
      success: true,
      message: "Payment received successfully",
      data: enrichPayment(result.rows[0]),
    });
  } catch (error) {
    console.error("❌ Receive payment error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to receive payment",
      error: error.message,
    });
  }
});

// ============================================================
// 6. MARK OVERDUE
// PATCH /api/payments/:id/overdue
//
// This status can be used when a pending payment is late.
// ============================================================

router.patch("/:id/overdue", authenticate, async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment ID",
      });
    }

    const result = await db.query(
      `
      UPDATE personal_payments
      SET
        status = 'Overdue',
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
        AND user_id = $2
        AND status = 'Pending'
      RETURNING *
      `,
      [id, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message:
          "Pending payment not found or already updated",
      });
    }

    return res.json({
      success: true,
      message: "Payment marked as overdue",
      data: enrichPayment(result.rows[0]),
    });
  } catch (error) {
    console.error("❌ Overdue payment error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to mark payment overdue",
      error: error.message,
    });
  }
});

// ============================================================
// 7. MARK LOST
// PATCH /api/payments/:id/lost
//
// Used when payment is not received and is treated as lost.
// ============================================================

router.patch("/:id/lost", authenticate, async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment ID",
      });
    }

    const result = await db.query(
      `
      UPDATE personal_payments
      SET
        status = 'Lost',
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
        AND user_id = $2
        AND status IN ('Pending', 'Overdue')
      RETURNING *
      `,
      [id, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message:
          "Pending/overdue payment not found",
      });
    }

    return res.json({
      success: true,
      message: "Payment marked as lost",
      data: enrichPayment(result.rows[0]),
    });
  } catch (error) {
    console.error("❌ Lost payment error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to mark payment lost",
      error: error.message,
    });
  }
});

// ============================================================
// 8. DELETE PAYMENT
// DELETE /api/payments/:id
// ============================================================

router.delete("/:id", authenticate, async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment ID",
      });
    }

    const result = await db.query(
      `
      DELETE FROM personal_payments
      WHERE id = $1
        AND user_id = $2
      RETURNING *
      `,
      [id, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Payment not found",
      });
    }

    return res.json({
      success: true,
      message: "Payment deleted successfully",
      data: enrichPayment(result.rows[0]),
    });
  } catch (error) {
    console.error("❌ Delete payment error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to delete payment",
      error: error.message,
    });
  }
});

// ============================================================
// 9. MONTHLY SUMMARY
// GET /api/payments/monthly-summary?month=2026-08
//
// Selected month only.
// Shows:
// - Total received
// - Total pending
// - Total overdue
// - Total lost
// - Category totals
// - Received count
// - Pending count
// - Overdue count
// - Lost count
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

    const totalsResult = await db.query(
      `
      SELECT
        COALESCE(
          SUM(amount) FILTER (WHERE status = 'Received'),
          0
        ) AS total_received,

        COALESCE(
          SUM(amount) FILTER (WHERE status = 'Pending'),
          0
        ) AS total_pending,

        COALESCE(
          SUM(amount) FILTER (WHERE status = 'Overdue'),
          0
        ) AS total_overdue,

        COALESCE(
          SUM(amount) FILTER (WHERE status = 'Lost'),
          0
        ) AS total_lost,

        COUNT(*) FILTER (
          WHERE status = 'Received'
        )::INTEGER AS received_count,

        COUNT(*) FILTER (
          WHERE status = 'Pending'
        )::INTEGER AS pending_count,

        COUNT(*) FILTER (
          WHERE status = 'Overdue'
        )::INTEGER AS overdue_count,

        COUNT(*) FILTER (
          WHERE status = 'Lost'
        )::INTEGER AS lost_count,

        COALESCE(SUM(amount), 0) AS total_amount,

        COUNT(*)::INTEGER AS total_count

      FROM personal_payments

      WHERE user_id = $1
        AND payment_date >= $2::DATE
        AND payment_date < $3::DATE
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

        COALESCE(
          SUM(amount) FILTER (
            WHERE status = 'Received'
          ),
          0
        ) AS received,

        COALESCE(
          SUM(amount) FILTER (
            WHERE status = 'Pending'
          ),
          0
        ) AS pending,

        COALESCE(
          SUM(amount) FILTER (
            WHERE status = 'Overdue'
          ),
          0
        ) AS overdue,

        COALESCE(
          SUM(amount) FILTER (
            WHERE status = 'Lost'
          ),
          0
        ) AS lost,

        COUNT(*)::INTEGER AS count

      FROM personal_payments

      WHERE user_id = $1
        AND payment_date >= $2::DATE
        AND payment_date < $3::DATE

      GROUP BY category
      ORDER BY total DESC, category ASC
      `,
      [
        req.userId,
        range.monthStart,
        range.nextMonthStart,
      ]
    );

    const row = totalsResult.rows[0];

    return res.json({
      success: true,
      month,

      totals: {
        total_received: Number(row.total_received || 0),
        total_pending: Number(row.total_pending || 0),
        total_overdue: Number(row.total_overdue || 0),
        total_lost: Number(row.total_lost || 0),
        total_amount: Number(row.total_amount || 0),
      },

      counts: {
        received: Number(row.received_count || 0),
        pending: Number(row.pending_count || 0),
        overdue: Number(row.overdue_count || 0),
        lost: Number(row.lost_count || 0),
        total: Number(row.total_count || 0),
      },

      categories: categoryResult.rows.map((item) => ({
        category: item.category,
        total: Number(item.total || 0),
        received: Number(item.received || 0),
        pending: Number(item.pending || 0),
        overdue: Number(item.overdue || 0),
        lost: Number(item.lost || 0),
        count: Number(item.count || 0),
      })),
    });
  } catch (error) {
    console.error("❌ Payment monthly summary error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to calculate payment summary",
      error: error.message,
    });
  }
});

// ============================================================
// 10. PAYMENT DATE DIFFERENCE
// GET /api/payments/:id/difference
// ============================================================

router.get("/:id/difference", authenticate, async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment ID",
      });
    }

    const result = await db.query(
      `
      SELECT
        id,
        payment_date,
        received_at,
        status
      FROM personal_payments
      WHERE id = $1
        AND user_id = $2
      `,
      [id, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Payment not found",
      });
    }

    const row = result.rows[0];

    const receivedDate = row.received_at
      ? String(row.received_at).slice(0, 10)
      : null;

    return res.json({
      success: true,

      data: {
        payment_date: row.payment_date,
        received_date: receivedDate,
        status: row.status,
        ...calculateDateDifference(
          row.payment_date,
          receivedDate
        ),
      },
    });
  } catch (error) {
    console.error("❌ Payment difference error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to calculate payment difference",
      error: error.message,
    });
  }
});

// ============================================================
// 11. AUTO STATUS CHECK
// PATCH /api/payments/auto-status
//
// Pending payments remain Pending until explicitly marked
// overdue/lost. This endpoint can be called by the dashboard
// to classify payments based on the current date.
//
// Rule:
// payment_date < CURRENT_DATE -> Overdue
// ============================================================

router.patch("/auto-status", authenticate, async (req, res) => {
  try {
    const result = await db.query(
      `
      UPDATE personal_payments
      SET
        status = 'Overdue',
        updated_at = CURRENT_TIMESTAMP
      WHERE user_id = $1
        AND status = 'Pending'
        AND payment_date < CURRENT_DATE
      RETURNING id
      `,
      [req.userId]
    );

    return res.json({
      success: true,
      message: "Payment statuses checked successfully",
      updated_count: result.rows.length,
      updated_ids: result.rows.map((row) => row.id),
    });
  } catch (error) {
    console.error("❌ Auto payment status error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to update payment statuses",
      error: error.message,
    });
  }
});

// ============================================================
// 12. TOTALS FOR SELECTED MONTH
// GET /api/payments/totals?month=2026-08
// ============================================================

router.get("/totals", authenticate, async (req, res) => {
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
        COALESCE(
          SUM(amount) FILTER (WHERE status = 'Received'),
          0
        ) AS received,

        COALESCE(
          SUM(amount) FILTER (WHERE status = 'Pending'),
          0
        ) AS pending,

        COALESCE(
          SUM(amount) FILTER (WHERE status = 'Overdue'),
          0
        ) AS overdue,

        COALESCE(
          SUM(amount) FILTER (WHERE status = 'Lost'),
          0
        ) AS lost,

        COALESCE(SUM(amount), 0) AS total

      FROM personal_payments

      WHERE user_id = $1
        AND payment_date >= $2::DATE
        AND payment_date < $3::DATE
      `,
      [
        req.userId,
        range.monthStart,
        range.nextMonthStart,
      ]
    );

    const row = result.rows[0];

    return res.json({
      success: true,
      month,

      data: {
        received: Number(row.received || 0),
        pending: Number(row.pending || 0),
        overdue: Number(row.overdue || 0),
        lost: Number(row.lost || 0),
        total: Number(row.total || 0),
      },
    });
  } catch (error) {
    console.error("❌ Payment totals error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to calculate payment totals",
      error: error.message,
    });
  }
});

// ============================================================
// EXPORT
// ============================================================

module.exports = router;