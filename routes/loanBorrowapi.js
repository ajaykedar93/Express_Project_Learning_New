// routes/loanBorrowApi.js
// Loan & Borrow API
// Complete CRUD + EMI/repayment + remaining days/months + pagination
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

  return {
    monthStart,
    nextMonthStart,
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

const parsePositiveNumber = (value, allowZero = false) => {
  const number = Number(value);

  if (
    !Number.isFinite(number) ||
    (allowZero ? number < 0 : number <= 0)
  ) {
    return null;
  }

  return number;
};

const parseNonNegativeInteger = (value) => {
  const number = Number(value);

  if (!Number.isInteger(number) || number < 0) {
    return null;
  }

  return number;
};

const normalizeType = (value) => {
  if (!value) return null;

  const type = String(value).trim().toLowerCase();

  if (type === "loan") return "Loan";
  if (type === "borrow") return "Borrow";

  return null;
};

const normalizeStatus = (value) => {
  if (!value) return "Active";

  const status = String(value).trim().toLowerCase();

  if (status === "active") return "Active";
  if (status === "completed") return "Completed";
  if (status === "overdue") return "Overdue";

  return null;
};

// ============================================================
// REMAINING TIME
// ============================================================

const calculateRemaining = (dueDate) => {
  if (!dueDate) {
    return {
      status: "No Due Date",
      remaining_days: null,
      remaining_months: null,
    };
  }

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const due = new Date(`${dueDate}T00:00:00Z`);

  const diffMs = due.getTime() - today.getTime();
  const remainingDays = Math.ceil(
    diffMs / (1000 * 60 * 60 * 24)
  );

  if (remainingDays < 0) {
    return {
      status: "Overdue",
      remaining_days: 0,
      remaining_months: 0,
    };
  }

  if (remainingDays === 0) {
    return {
      status: "Due Today",
      remaining_days: 0,
      remaining_months: 0,
    };
  }

  // Calendar-month calculation.
  // This avoids showing a wrong month value for partial months.
  const todayYear = today.getUTCFullYear();
  const todayMonth = today.getUTCMonth();
  const todayDay = today.getUTCDate();

  const dueYear = due.getUTCFullYear();
  const dueMonth = due.getUTCMonth();
  const dueDay = due.getUTCDate();

  let months =
    (dueYear - todayYear) * 12 +
    (dueMonth - todayMonth);

  if (dueDay < todayDay) {
    months -= 1;
  }

  months = Math.max(0, months);

  return {
    status: "Active",
    remaining_days: remainingDays,
    remaining_months: months,
  };
};

const addRemainingData = (row) => {
  const dueDate =
    row.type === "Loan"
      ? row.end_date
      : row.return_date;

  return {
    ...row,
    amount: Number(row.amount || 0),
    emi: Number(row.emi || 0),
    due_date: dueDate || null,
    ...calculateRemaining(dueDate),
  };
};

// ============================================================
// TABLES
// ============================================================

const createTables = async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS personal_loans_borrow (
        id SERIAL PRIMARY KEY,

        user_id INTEGER NOT NULL
          REFERENCES personal_users(id)
          ON DELETE CASCADE,

        name VARCHAR(150) NOT NULL,

        type VARCHAR(20) NOT NULL
          CHECK (type IN ('Borrow', 'Loan')),

        amount NUMERIC(15,2) NOT NULL,

        emi NUMERIC(15,2) DEFAULT 0,

        start_date DATE NOT NULL DEFAULT CURRENT_DATE,

        end_date DATE,

        return_date DATE,

        status VARCHAR(20) NOT NULL DEFAULT 'Active'
          CHECK (status IN ('Active', 'Completed', 'Overdue')),

        notes TEXT,

        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

        CONSTRAINT chk_loan_borrow_amount
          CHECK (amount > 0),

        CONSTRAINT chk_loan_emi
          CHECK (emi >= 0),

        CONSTRAINT chk_loan_borrow_dates
          CHECK (
            end_date IS NULL
            OR end_date >= start_date
          ),

        CONSTRAINT chk_borrow_return_date
          CHECK (
            type = 'Loan'
            OR return_date IS NOT NULL
          ),

        CONSTRAINT chk_loan_end_date
          CHECK (
            type = 'Borrow'
            OR end_date IS NOT NULL
          )
      )
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS personal_loan_emi_payments (
        id SERIAL PRIMARY KEY,

        user_id INTEGER NOT NULL
          REFERENCES personal_users(id)
          ON DELETE CASCADE,

        loan_id INTEGER NOT NULL
          REFERENCES personal_loans_borrow(id)
          ON DELETE CASCADE,

        amount NUMERIC(15,2) NOT NULL,

        payment_date DATE NOT NULL DEFAULT CURRENT_DATE,

        payment_type VARCHAR(20) NOT NULL
          CHECK (
            payment_type IN (
              'EMI',
              'Borrow Repayment',
              'Loan Repayment'
            )
          ),

        notes TEXT,

        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

        CONSTRAINT chk_loan_payment_amount
          CHECK (amount > 0)
      )
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_loans_borrow_user
      ON personal_loans_borrow(user_id)
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_loans_borrow_type
      ON personal_loans_borrow(user_id, type)
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_loans_borrow_dates
      ON personal_loans_borrow(
        user_id,
        start_date,
        end_date,
        return_date
      )
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_loans_borrow_status
      ON personal_loans_borrow(user_id, status)
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_loan_emi_user_date
      ON personal_loan_emi_payments(user_id, payment_date)
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_loan_emi_loan
      ON personal_loan_emi_payments(loan_id)
    `);

    console.log("✅ Loan & Borrow tables ready");
  } catch (error) {
    console.error(
      "❌ Loan/Borrow table setup error:",
      error.message
    );
  }
};

createTables();

// ============================================================
// 1. CREATE LOAN / BORROW
// POST /api/loans-borrow
//
// Borrow:
//   name, amount, return_date, notes
//
// Loan:
//   name, amount, emi, start_date, end_date, notes
// ============================================================

router.post("/", authenticate, async (req, res) => {
  try {
    const {
      name,
      amount,
      emi,
      start_date,
      end_date,
      return_date,
      type,
      notes,
    } = req.body;

    const normalizedType = normalizeType(type);

    if (!name || !String(name).trim()) {
      return res.status(400).json({
        success: false,
        message: "Name is required",
      });
    }

    if (!normalizedType) {
      return res.status(400).json({
        success: false,
        message: "Type must be Loan or Borrow",
      });
    }

    const numericAmount = parsePositiveNumber(amount);

    if (numericAmount === null) {
      return res.status(400).json({
        success: false,
        message: "Amount must be greater than 0",
      });
    }

    const numericEmi =
      emi === undefined ||
      emi === null ||
      emi === ""
        ? 0
        : parsePositiveNumber(emi, true);

    if (numericEmi === null) {
      return res.status(400).json({
        success: false,
        message: "EMI must be a valid non-negative number",
      });
    }

    const startDate =
      start_date ||
      new Date().toISOString().slice(0, 10);

    if (!isValidDate(startDate)) {
      return res.status(400).json({
        success: false,
        message: "Invalid start date",
      });
    }

    if (normalizedType === "Loan") {
      if (!end_date) {
        return res.status(400).json({
          success: false,
          message: "Loan end date is required",
        });
      }

      if (!isValidDate(end_date)) {
        return res.status(400).json({
          success: false,
          message: "Invalid loan end date",
        });
      }

      if (end_date < startDate) {
        return res.status(400).json({
          success: false,
          message: "Loan end date cannot be before start date",
        });
      }

      if (numericEmi <= 0) {
        return res.status(400).json({
          success: false,
          message: "Loan EMI must be greater than 0",
        });
      }
    }

    if (normalizedType === "Borrow") {
      if (!return_date) {
        return res.status(400).json({
          success: false,
          message: "Borrow return date is required",
        });
      }

      if (!isValidDate(return_date)) {
        return res.status(400).json({
          success: false,
          message: "Invalid borrow return date",
        });
      }

      if (return_date < startDate) {
        return res.status(400).json({
          success: false,
          message:
            "Borrow return date cannot be before borrow date",
        });
      }
    }

    const result = await db.query(
      `
      INSERT INTO personal_loans_borrow (
        user_id,
        name,
        type,
        amount,
        emi,
        start_date,
        end_date,
        return_date,
        status,
        notes
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,'Active',$9
      )
      RETURNING *
      `,
      [
        req.userId,
        String(name).trim(),
        normalizedType,
        numericAmount,
        numericEmi,
        startDate,
        normalizedType === "Loan"
          ? end_date
          : null,
        normalizedType === "Borrow"
          ? return_date
          : null,
        notes || null,
      ]
    );

    return res.status(201).json({
      success: true,
      message: `${normalizedType} added successfully`,
      data: addRemainingData(result.rows[0]),
    });
  } catch (error) {
    console.error("❌ Create loan/borrow error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to add loan/borrow",
      error: error.message,
    });
  }
});

// ============================================================
// 2. GET ALL LOAN / BORROW
// GET /api/loans-borrow?type=Loan&status=Active
//
// Default page size = 10.
// ============================================================

router.get("/", authenticate, async (req, res) => {
  try {
    const type = req.query.type
      ? normalizeType(req.query.type)
      : null;

    const status = req.query.status
      ? normalizeStatus(req.query.status)
      : null;

    const page = Math.max(
      1,
      Number(req.query.page) || 1
    );

    const limit = Math.min(
      10,
      Math.max(
        1,
        Number(req.query.limit) || 10
      )
    );

    const offset = (page - 1) * limit;

    if (req.query.type && !type) {
      return res.status(400).json({
        success: false,
        message: "Invalid type",
      });
    }

    if (req.query.status && !status) {
      return res.status(400).json({
        success: false,
        message: "Invalid status",
      });
    }

    let where = `
      WHERE user_id = $1
    `;

    const values = [req.userId];
    let index = 2;

    if (type) {
      where += ` AND type = $${index}`;
      values.push(type);
      index++;
    }

    if (status) {
      where += ` AND status = $${index}`;
      values.push(status);
      index++;
    }

    const countResult = await db.query(
      `
      SELECT COUNT(*)::INTEGER AS total
      FROM personal_loans_borrow
      ${where}
      `,
      values
    );

    const dataValues = [...values, limit, offset];

    const result = await db.query(
      `
      SELECT *
      FROM personal_loans_borrow
      ${where}
      ORDER BY
        CASE
          WHEN type = 'Loan' THEN end_date
          ELSE return_date
        END ASC NULLS LAST,
        id DESC
      LIMIT $${index}
      OFFSET $${index + 1}
      `,
      dataValues
    );

    const total = Number(countResult.rows[0].total || 0);

    return res.json({
      success: true,

      pagination: {
        page,
        limit,
        total,
        total_pages: Math.ceil(total / limit),
        has_next: page < Math.ceil(total / limit),
        has_previous: page > 1,
      },

      data: result.rows.map(addRemainingData),
    });
  } catch (error) {
    console.error("❌ Get loan/borrow error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch loan/borrow records",
      error: error.message,
    });
  }
});

// ============================================================
// 3. GET SINGLE LOAN / BORROW
// GET /api/loans-borrow/:id
// ============================================================

router.get("/:id", authenticate, async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid loan/borrow ID",
      });
    }

    const result = await db.query(
      `
      SELECT *
      FROM personal_loans_borrow
      WHERE id = $1
        AND user_id = $2
      `,
      [id, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Loan/Borrow not found",
      });
    }

    const payments = await db.query(
      `
      SELECT *
      FROM personal_loan_emi_payments
      WHERE loan_id = $1
        AND user_id = $2
      ORDER BY payment_date DESC, id DESC
      `,
      [id, req.userId]
    );

    const loan = result.rows[0];

    return res.json({
      success: true,

      data: {
        ...addRemainingData(loan),

        repayments: payments.rows.map((row) => ({
          ...row,
          amount: Number(row.amount || 0),
        })),
      },
    });
  } catch (error) {
    console.error("❌ Get single loan/borrow error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch loan/borrow",
      error: error.message,
    });
  }
});

// ============================================================
// 4. UPDATE LOAN / BORROW
// PUT /api/loans-borrow/:id
// ============================================================

router.put("/:id", authenticate, async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid loan/borrow ID",
      });
    }

    const existing = await db.query(
      `
      SELECT *
      FROM personal_loans_borrow
      WHERE id = $1
        AND user_id = $2
      `,
      [id, req.userId]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Loan/Borrow not found",
      });
    }

    const old = existing.rows[0];

    const {
      name,
      amount,
      emi,
      start_date,
      end_date,
      return_date,
      type,
      status,
      notes,
    } = req.body;

    const finalName =
      name !== undefined
        ? String(name).trim()
        : old.name;

    const finalType =
      type !== undefined
        ? normalizeType(type)
        : old.type;

    const finalStatus =
      status !== undefined
        ? normalizeStatus(status)
        : old.status;

    const finalAmount =
      amount !== undefined
        ? parsePositiveNumber(amount)
        : Number(old.amount);

    const finalEmi =
      emi !== undefined
        ? parsePositiveNumber(emi, true)
        : Number(old.emi);

    const finalStartDate =
      start_date !== undefined
        ? start_date
        : old.start_date;

    let finalEndDate =
      end_date !== undefined
        ? end_date
        : old.end_date;

    let finalReturnDate =
      return_date !== undefined
        ? return_date
        : old.return_date;

    const finalNotes =
      notes !== undefined
        ? notes
        : old.notes;

    if (!finalName) {
      return res.status(400).json({
        success: false,
        message: "Name is required",
      });
    }

    if (!finalType || !finalStatus) {
      return res.status(400).json({
        success: false,
        message: "Invalid type or status",
      });
    }

    if (
      finalAmount === null ||
      finalAmount <= 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Amount must be greater than 0",
      });
    }

    if (
      finalEmi === null ||
      finalEmi < 0
    ) {
      return res.status(400).json({
        success: false,
        message: "EMI must be non-negative",
      });
    }

    if (!isValidDate(String(finalStartDate))) {
      return res.status(400).json({
        success: false,
        message: "Invalid start date",
      });
    }

    if (finalType === "Loan") {
      if (!finalEndDate) {
        return res.status(400).json({
          success: false,
          message: "Loan end date is required",
        });
      }

      if (!isValidDate(String(finalEndDate))) {
        return res.status(400).json({
          success: false,
          message: "Invalid loan end date",
        });
      }

      if (finalEndDate < finalStartDate) {
        return res.status(400).json({
          success: false,
          message:
            "Loan end date cannot be before start date",
        });
      }

      if (finalEmi <= 0) {
        return res.status(400).json({
          success: false,
          message: "Loan EMI must be greater than 0",
        });
      }

      finalReturnDate = null;
    }

    if (finalType === "Borrow") {
      if (!finalReturnDate) {
        return res.status(400).json({
          success: false,
          message: "Borrow return date is required",
        });
      }

      if (!isValidDate(String(finalReturnDate))) {
        return res.status(400).json({
          success: false,
          message: "Invalid borrow return date",
        });
      }

      if (finalReturnDate < finalStartDate) {
        return res.status(400).json({
          success: false,
          message:
            "Borrow return date cannot be before borrow date",
        });
      }

      finalEndDate = null;
    }

    const result = await db.query(
      `
      UPDATE personal_loans_borrow
      SET
        name = $1,
        type = $2,
        amount = $3,
        emi = $4,
        start_date = $5,
        end_date = $6,
        return_date = $7,
        status = $8,
        notes = $9,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $10
        AND user_id = $11
      RETURNING *
      `,
      [
        finalName,
        finalType,
        finalAmount,
        finalEmi,
        finalStartDate,
        finalEndDate || null,
        finalReturnDate || null,
        finalStatus,
        finalNotes || null,
        id,
        req.userId,
      ]
    );

    return res.json({
      success: true,
      message: "Loan/Borrow updated successfully",
      data: addRemainingData(result.rows[0]),
    });
  } catch (error) {
    console.error("❌ Update loan/borrow error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to update loan/borrow",
      error: error.message,
    });
  }
});

// ============================================================
// 5. DELETE LOAN / BORROW
// DELETE /api/loans-borrow/:id
// ============================================================

router.delete("/:id", authenticate, async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid loan/borrow ID",
      });
    }

    const result = await db.query(
      `
      DELETE FROM personal_loans_borrow
      WHERE id = $1
        AND user_id = $2
      RETURNING id, name, type
      `,
      [id, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Loan/Borrow not found",
      });
    }

    return res.json({
      success: true,
      message: "Loan/Borrow deleted successfully",
      data: result.rows[0],
    });
  } catch (error) {
    console.error("❌ Delete loan/borrow error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to delete loan/borrow",
      error: error.message,
    });
  }
});

// ============================================================
// 6. MARK COMPLETED
// PATCH /api/loans-borrow/:id/complete
// ============================================================

router.patch("/:id/complete", authenticate, async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid loan/borrow ID",
      });
    }

    const result = await db.query(
      `
      UPDATE personal_loans_borrow
      SET
        status = 'Completed',
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
        AND user_id = $2
      RETURNING *
      `,
      [id, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Loan/Borrow not found",
      });
    }

    return res.json({
      success: true,
      message: "Loan/Borrow marked as completed",
      data: addRemainingData(result.rows[0]),
    });
  } catch (error) {
    console.error("❌ Complete loan/borrow error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to complete loan/borrow",
      error: error.message,
    });
  }
});

// ============================================================
// 7. MARK OVERDUE
// PATCH /api/loans-borrow/:id/overdue
// ============================================================

router.patch("/:id/overdue", authenticate, async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid loan/borrow ID",
      });
    }

    const result = await db.query(
      `
      UPDATE personal_loans_borrow
      SET
        status = 'Overdue',
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
        AND user_id = $2
      RETURNING *
      `,
      [id, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Loan/Borrow not found",
      });
    }

    return res.json({
      success: true,
      message: "Loan/Borrow marked as overdue",
      data: addRemainingData(result.rows[0]),
    });
  } catch (error) {
    console.error("❌ Mark overdue error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to mark loan/borrow overdue",
      error: error.message,
    });
  }
});

// ============================================================
// 8. RECORD EMI / REPAYMENT
// POST /api/loans-borrow/:id/repayment
//
// payment_type:
//   EMI
//   Loan Repayment
//   Borrow Repayment
// ============================================================

router.post("/:id/repayment", authenticate, async (req, res) => {
  const client = await db.connect();

  try {
    const loanId = Number(req.params.id);

    if (!Number.isInteger(loanId) || loanId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid loan/borrow ID",
      });
    }

    const {
      amount,
      payment_date,
      payment_type,
      notes,
    } = req.body;

    const numericAmount = parsePositiveNumber(amount);

    if (numericAmount === null) {
      return res.status(400).json({
        success: false,
        message: "Repayment amount must be greater than 0",
      });
    }

    const allowedTypes = [
      "EMI",
      "Loan Repayment",
      "Borrow Repayment",
    ];

    if (!allowedTypes.includes(payment_type)) {
      return res.status(400).json({
        success: false,
        message: "Invalid repayment type",
      });
    }

    const date =
      payment_date ||
      new Date().toISOString().slice(0, 10);

    if (!isValidDate(date)) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment date",
      });
    }

    await client.query("BEGIN");

    const loanResult = await client.query(
      `
      SELECT *
      FROM personal_loans_borrow
      WHERE id = $1
        AND user_id = $2
      FOR UPDATE
      `,
      [loanId, req.userId]
    );

    if (loanResult.rows.length === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        success: false,
        message: "Loan/Borrow not found",
      });
    }

    const loan = loanResult.rows[0];

    // Prevent logically incorrect repayment types.
    if (
      loan.type === "Loan" &&
      payment_type === "Borrow Repayment"
    ) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        success: false,
        message:
          "Borrow Repayment can only be used for Borrow records",
      });
    }

    if (
      loan.type === "Borrow" &&
      payment_type === "EMI"
    ) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        success: false,
        message:
          "EMI can only be used for Loan records",
      });
    }

    const repaymentResult = await client.query(
      `
      INSERT INTO personal_loan_emi_payments (
        user_id,
        loan_id,
        amount,
        payment_date,
        payment_type,
        notes
      )
      VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING *
      `,
      [
        req.userId,
        loanId,
        numericAmount,
        date,
        payment_type,
        notes || null,
      ]
    );

    // Total actual repayment for this loan/borrow.
    const totalPaidResult = await client.query(
      `
      SELECT
        COALESCE(SUM(amount), 0) AS total_paid
      FROM personal_loan_emi_payments
      WHERE loan_id = $1
        AND user_id = $2
      `,
      [loanId, req.userId]
    );

    const totalPaid =
      Number(totalPaidResult.rows[0].total_paid || 0);

    let newStatus = loan.status;

    // If total actual paid reaches the original amount,
    // automatically mark the record completed.
    if (totalPaid >= Number(loan.amount)) {
      newStatus = "Completed";
    } else {
      const dueDate =
        loan.type === "Loan"
          ? loan.end_date
          : loan.return_date;

      if (
        dueDate &&
        dueDate < new Date().toISOString().slice(0, 10)
      ) {
        newStatus = "Overdue";
      } else {
        newStatus = "Active";
      }
    }

    await client.query(
      `
      UPDATE personal_loans_borrow
      SET
        status = $1,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
        AND user_id = $3
      `,
      [
        newStatus,
        loanId,
        req.userId,
      ]
    );

    await client.query("COMMIT");

    return res.status(201).json({
      success: true,
      message: "Repayment recorded successfully",

      data: {
        repayment: {
          ...repaymentResult.rows[0],
          amount: numericAmount,
        },

        loan: {
          ...addRemainingData({
            ...loan,
            status: newStatus,
          }),
          total_paid: totalPaid,
          remaining_amount: Math.max(
            0,
            Number(loan.amount) - totalPaid
          ),
        },
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error("❌ Record repayment error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to record repayment",
      error: error.message,
    });
  } finally {
    client.release();
  }
});

// ============================================================
// 9. GET REPAYMENT HISTORY
// GET /api/loans-borrow/:id/repayments
// ============================================================

router.get("/:id/repayments", authenticate, async (req, res) => {
  try {
    const loanId = Number(req.params.id);

    if (!Number.isInteger(loanId) || loanId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid loan/borrow ID",
      });
    }

    const ownerResult = await db.query(
      `
      SELECT id
      FROM personal_loans_borrow
      WHERE id = $1
        AND user_id = $2
      `,
      [loanId, req.userId]
    );

    if (ownerResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Loan/Borrow not found",
      });
    }

    const result = await db.query(
      `
      SELECT *
      FROM personal_loan_emi_payments
      WHERE loan_id = $1
        AND user_id = $2
      ORDER BY payment_date DESC, id DESC
      `,
      [loanId, req.userId]
    );

    const totalPaid = result.rows.reduce(
      (sum, row) => sum + Number(row.amount || 0),
      0
    );

    return res.json({
      success: true,
      total_paid: totalPaid,
      count: result.rows.length,

      data: result.rows.map((row) => ({
        ...row,
        amount: Number(row.amount || 0),
      })),
    });
  } catch (error) {
    console.error("❌ Repayment history error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch repayment history",
      error: error.message,
    });
  }
});

// ============================================================
// 10. MONTHLY SUMMARY
// GET /api/loans-borrow/monthly-summary?month=2026-08
//
// Shows loans/borrowings active or relevant during selected month
// and actual repayments made in that month.
// ============================================================

router.get("/monthly-summary", authenticate, async (req, res) => {
  try {
    const month =
      req.query.month || getCurrentMonth();

    const range = getMonthRange(month);

    if (!range) {
      return res.status(400).json({
        success: false,
        message: "Invalid month. Use YYYY-MM.",
      });
    }

    const recordsResult = await db.query(
      `
      SELECT *
      FROM personal_loans_borrow
      WHERE user_id = $1
        AND start_date < $2::DATE
        AND (
          (
            type = 'Loan'
            AND (
              end_date IS NULL
              OR end_date >= $3::DATE
            )
          )
          OR
          (
            type = 'Borrow'
            AND (
              return_date IS NULL
              OR return_date >= $3::DATE
            )
          )
        )
      ORDER BY
        CASE
          WHEN type = 'Loan' THEN end_date
          ELSE return_date
        END ASC NULLS LAST,
        id DESC
      `,
      [
        req.userId,
        range.nextMonthStart,
        range.monthStart,
      ]
    );

    const repaymentResult = await db.query(
      `
      SELECT
        COALESCE(
          SUM(amount) FILTER (
            WHERE payment_type = 'EMI'
          ),
          0
        ) AS emi_paid,

        COALESCE(
          SUM(amount) FILTER (
            WHERE payment_type = 'Loan Repayment'
          ),
          0
        ) AS loan_repayment,

        COALESCE(
          SUM(amount) FILTER (
            WHERE payment_type = 'Borrow Repayment'
          ),
          0
        ) AS borrow_repayment,

        COALESCE(SUM(amount), 0) AS total_repayment

      FROM personal_loan_emi_payments
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

    const countsResult = await db.query(
      `
      SELECT
        COUNT(*) FILTER (
          WHERE type = 'Loan'
            AND status = 'Active'
        )::INTEGER AS active_loans,

        COUNT(*) FILTER (
          WHERE type = 'Borrow'
            AND status = 'Active'
        )::INTEGER AS active_borrows,

        COUNT(*) FILTER (
          WHERE type = 'Loan'
            AND status = 'Overdue'
        )::INTEGER AS overdue_loans,

        COUNT(*) FILTER (
          WHERE type = 'Borrow'
            AND status = 'Overdue'
        )::INTEGER AS overdue_borrows

      FROM personal_loans_borrow
      WHERE user_id = $1
      `,
      [req.userId]
    );

    const repayment = repaymentResult.rows[0];
    const counts = countsResult.rows[0];

    return res.json({
      success: true,
      month,

      totals: {
        emi_paid: Number(repayment.emi_paid || 0),
        loan_repayment: Number(
          repayment.loan_repayment || 0
        ),
        borrow_repayment: Number(
          repayment.borrow_repayment || 0
        ),
        total_repayment: Number(
          repayment.total_repayment || 0
        ),
      },

      counts: {
        active_loans: Number(
          counts.active_loans || 0
        ),
        active_borrows: Number(
          counts.active_borrows || 0
        ),
        overdue_loans: Number(
          counts.overdue_loans || 0
        ),
        overdue_borrows: Number(
          counts.overdue_borrows || 0
        ),
      },

      data: recordsResult.rows.map(addRemainingData),
    });
  } catch (error) {
    console.error("❌ Loan monthly summary error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to calculate monthly loan summary",
      error: error.message,
    });
  }
});

// ============================================================
// 11. UPCOMING DUE RECORDS
// GET /api/loans-borrow/upcoming
//
// Optional:
//   days=30
// ============================================================

router.get("/upcoming", authenticate, async (req, res) => {
  try {
    const requestedDays =
      Number(req.query.days ?? 60);

    const days =
      Number.isInteger(requestedDays) &&
      requestedDays >= 0
        ? Math.min(requestedDays, 3650)
        : 60;

    const result = await db.query(
      `
      SELECT *
      FROM personal_loans_borrow
      WHERE user_id = $1
        AND status = 'Active'
        AND (
          (
            type = 'Loan'
            AND end_date >= CURRENT_DATE
            AND end_date <= CURRENT_DATE + ($2 * INTERVAL '1 day')
          )
          OR
          (
            type = 'Borrow'
            AND return_date >= CURRENT_DATE
            AND return_date <= CURRENT_DATE + ($2 * INTERVAL '1 day')
          )
        )
      ORDER BY
        CASE
          WHEN type = 'Loan' THEN end_date
          ELSE return_date
        END ASC,
        id ASC
      `,
      [req.userId, days]
    );

    return res.json({
      success: true,
      days,
      count: result.rows.length,
      data: result.rows.map(addRemainingData),
    });
  } catch (error) {
    console.error("❌ Upcoming records error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch upcoming records",
      error: error.message,
    });
  }
});

// ============================================================
// 12. TOTALS
// GET /api/loans-borrow/totals
//
// Total Borrow
// Total Loan
// Combined total
// Actual repayment
// Remaining amount
// ============================================================

router.get("/totals", authenticate, async (req, res) => {
  try {
    const result = await db.query(
      `
      SELECT
        COALESCE(
          SUM(amount) FILTER (
            WHERE type = 'Borrow'
          ),
          0
        ) AS total_borrow,

        COALESCE(
          SUM(amount) FILTER (
            WHERE type = 'Loan'
          ),
          0
        ) AS total_loan,

        COALESCE(SUM(amount), 0) AS combined_total,

        COUNT(*) FILTER (
          WHERE type = 'Borrow'
        )::INTEGER AS borrow_count,

        COUNT(*) FILTER (
          WHERE type = 'Loan'
        )::INTEGER AS loan_count

      FROM personal_loans_borrow
      WHERE user_id = $1
    `,
      [req.userId]
    );

    const repaymentResult = await db.query(
      `
      SELECT
        COALESCE(SUM(amount), 0) AS total_repaid
      FROM personal_loan_emi_payments
      WHERE user_id = $1
      `,
      [req.userId]
    );

    const row = result.rows[0];

    const totalBorrow =
      Number(row.total_borrow || 0);

    const totalLoan =
      Number(row.total_loan || 0);

    const combinedTotal =
      Number(row.combined_total || 0);

    const totalRepaid =
      Number(
        repaymentResult.rows[0].total_repaid || 0
      );

    return res.json({
      success: true,

      data: {
        borrow: {
          count: Number(row.borrow_count || 0),
          total: totalBorrow,
        },

        loan: {
          count: Number(row.loan_count || 0),
          total: totalLoan,
        },

        combined_total: combinedTotal,

        total_repaid: totalRepaid,

        combined_remaining: Math.max(
          0,
          combinedTotal - totalRepaid
        ),
      },
    });
  } catch (error) {
    console.error("❌ Loan/Borrow totals error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to calculate loan/borrow totals",
      error: error.message,
    });
  }
});

// ============================================================
// EXPORT
// ============================================================

module.exports = router;