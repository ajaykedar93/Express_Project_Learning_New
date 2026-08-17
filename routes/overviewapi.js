// routes/overviewApi.js
// Overview API - Business + Work management and selected-month overview
// CommonJS / Express / PostgreSQL

const express = require("express");
const jwt = require("jsonwebtoken");

const router = express.Router();
const db = require("../db.js");

// ============================================================
// AUTHENTICATION
// ============================================================

const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key";

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

const isValidDate = (value) => {
  if (!value || typeof value !== "string") return false;
  const date = new Date(`${value}T00:00:00`);
  return !Number.isNaN(date.getTime());
};

const getMonthRange = (month) => {
  // Expected: YYYY-MM
  if (!/^\d{4}-\d{2}$/.test(month || "")) {
    return null;
  }

  const [year, monthNumber] = month.split("-").map(Number);

  if (monthNumber < 1 || monthNumber > 12) {
    return null;
  }

  const start = `${year}-${String(monthNumber).padStart(2, "0")}-01`;

  const nextYear = monthNumber === 12 ? year + 1 : year;
  const nextMonth = monthNumber === 12 ? 1 : monthNumber + 1;
  const nextStart = `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`;

  return {
    monthStart: start,
    nextMonthStart: nextStart,
  };
};

const getCurrentMonth = () => {
  const now = new Date();

  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
};

const normalizeType = (type) => {
  if (!type) return null;

  const value = String(type).trim().toLowerCase();

  if (value === "business") return "Business";
  if (value === "work") return "Work";

  return null;
};

const normalizeStatus = (status) => {
  if (!status) return "Active";

  const value = String(status).trim().toLowerCase();

  if (value === "active") return "Active";
  if (value === "completed") return "Completed";
  if (value === "paused") return "Paused";

  return null;
};

const parsePositiveNumber = (value) => {
  const number = Number(value);

  if (!Number.isFinite(number) || number < 0) {
    return null;
  }

  return number;
};

// ============================================================
// CREATE / ENSURE TABLES
// ============================================================

const createTables = async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS personal_business_work (
        id SERIAL PRIMARY KEY,

        user_id INTEGER NOT NULL
          REFERENCES personal_users(id)
          ON DELETE CASCADE,

        name VARCHAR(200) NOT NULL,

        type VARCHAR(20) NOT NULL
          CHECK (type IN ('Business', 'Work')),

        status VARCHAR(20) NOT NULL DEFAULT 'Active'
          CHECK (status IN ('Active', 'Completed', 'Paused')),

        amount NUMERIC(15,2) DEFAULT 0,

        start_date DATE DEFAULT CURRENT_DATE,
        end_date DATE,

        notes TEXT,

        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

        CONSTRAINT chk_business_work_amount
          CHECK (amount >= 0),

        CONSTRAINT chk_business_work_dates
          CHECK (
            end_date IS NULL
            OR end_date >= start_date
          )
      )
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS personal_overview (
        id SERIAL PRIMARY KEY,

        user_id INTEGER NOT NULL
          REFERENCES personal_users(id)
          ON DELETE CASCADE,

        month_start DATE NOT NULL,

        total_business INTEGER NOT NULL DEFAULT 0,
        total_works INTEGER NOT NULL DEFAULT 0,

        business_payment NUMERIC(15,2) NOT NULL DEFAULT 0,
        work_payment NUMERIC(15,2) NOT NULL DEFAULT 0,

        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

        CONSTRAINT chk_overview_business
          CHECK (total_business >= 0),

        CONSTRAINT chk_overview_works
          CHECK (total_works >= 0),

        CONSTRAINT chk_business_payment
          CHECK (business_payment >= 0),

        CONSTRAINT chk_work_payment
          CHECK (work_payment >= 0),

        CONSTRAINT unique_user_overview_month
          UNIQUE (user_id, month_start)
      )
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_business_work_user
      ON personal_business_work(user_id)
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_business_work_user_type
      ON personal_business_work(user_id, type)
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_business_work_dates
      ON personal_business_work(user_id, start_date, end_date)
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_overview_user_month
      ON personal_overview(user_id, month_start)
    `);

    console.log("✅ Overview tables ready");
  } catch (error) {
    console.error("❌ Overview table setup error:", error.message);
  }
};

createTables();

// ============================================================
// 1. GET OVERVIEW
// GET /api/overview?month=2026-08
//
// This returns:
// - Manual total business
// - Manual total work
// - Manual business payment
// - Manual work payment
// - Automatically calculated monthly expenses
// - Borrow
// - Loan EMI
// - Savings
// - Profit/Loss/Saved status
// - Upcoming loan/borrow count
//
// Financial totals are calculated from the other financial tables.
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

    const { monthStart, nextMonthStart } = range;

    // ============================================================
    // MANUAL MONTHLY VALUES
    // Only these 4 overview values are entered by the user manually:
    // - Total Business
    // - Total Work
    // - Business Payment
    // - Work Payment
    //
    // All other overview values below are calculated automatically
    // from their respective financial tables.
    // ============================================================
    const manualOverviewResult = await db.query(
      `
      SELECT
        total_business,
        total_works,
        business_payment,
        work_payment
      FROM personal_overview
      WHERE user_id = $1
        AND month_start = $2::DATE
      LIMIT 1
      `,
      [req.userId, monthStart]
    );

    // Monthly expenses.
    const expenseResult = await db.query(
      `
      SELECT COALESCE(SUM(amount), 0) AS total_expenses
      FROM personal_expenses
      WHERE user_id = $1
        AND expense_date >= $2::DATE
        AND expense_date < $3::DATE
      `,
      [req.userId, monthStart, nextMonthStart]
    );

    // Actual EMI / loan / borrow repayments.
    const repaymentResult = await db.query(
      `
      SELECT
        COALESCE(
          SUM(amount) FILTER (
            WHERE payment_type = 'EMI'
          ),
          0
        ) AS loan_emi_paid,

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
        ) AS borrow_repayment

      FROM personal_loan_emi_payments
      WHERE user_id = $1
        AND payment_date >= $2::DATE
        AND payment_date < $3::DATE
      `,
      [req.userId, monthStart, nextMonthStart]
    );

    // Received payments.
    const paymentResult = await db.query(
      `
      SELECT
        COALESCE(SUM(amount), 0) AS total_received,

        COALESCE(
          SUM(amount) FILTER (WHERE category = 'Work'),
          0
        ) AS received_work,

        COALESCE(
          SUM(amount) FILTER (WHERE category = 'Business'),
          0
        ) AS received_business,

        COALESCE(
          SUM(amount) FILTER (WHERE category = 'Other'),
          0
        ) AS received_other

      FROM personal_payments
      WHERE user_id = $1
        AND status = 'Received'
        AND COALESCE(received_at::DATE, payment_date)
              >= $2::DATE
        AND COALESCE(received_at::DATE, payment_date)
              < $3::DATE
      `,
      [req.userId, monthStart, nextMonthStart]
    );

    // Active/upcoming loans and borrowings.
    const upcomingResult = await db.query(
      `
      SELECT
        COUNT(*) FILTER (
          WHERE type = 'Loan'
        )::INTEGER AS active_loans,

        COUNT(*) FILTER (
          WHERE type = 'Borrow'
        )::INTEGER AS active_borrows,

        COALESCE(
          SUM(amount) FILTER (
            WHERE type = 'Loan'
          ),
          0
        ) AS total_loan_amount,

        COALESCE(
          SUM(amount) FILTER (
            WHERE type = 'Borrow'
          ),
          0
        ) AS total_borrow_amount,

        MIN(end_date) FILTER (
          WHERE type = 'Loan'
            AND status = 'Active'
            AND end_date >= CURRENT_DATE
        ) AS next_loan_date,

        MIN(return_date) FILTER (
          WHERE type = 'Borrow'
            AND status = 'Active'
            AND return_date >= CURRENT_DATE
        ) AS next_borrow_date

      FROM personal_loans_borrow
      WHERE user_id = $1
        AND status = 'Active'
      `,
      [req.userId]
    );

    const manualOverview = manualOverviewResult.rows[0] || {
      total_business: 0,
      total_works: 0,
      business_payment: 0,
      work_payment: 0,
    };

    const expenses = expenseResult.rows[0];
    const repayments = repaymentResult.rows[0];
    const payments = paymentResult.rows[0];
    const upcoming = upcomingResult.rows[0];

    const totalBusiness = Number(manualOverview.total_business || 0);
    const totalWorks = Number(manualOverview.total_works || 0);
    const businessPayment = Number(manualOverview.business_payment || 0);
    const workPayment = Number(manualOverview.work_payment || 0);

    const receivedPayments = Number(payments.total_received || 0);

    // Business/work amount can be configured as work/business income.
    // Received payments are also included separately so the frontend can
    // display both operational income and actual received cash.
    const totalIncome =
      receivedPayments > 0
        ? receivedPayments
        : businessPayment + workPayment;

    const totalExpenses = Number(expenses.total_expenses || 0);

    const loanEmiPaid = Number(repayments.loan_emi_paid || 0);
    const loanRepayment = Number(repayments.loan_repayment || 0);
    const borrowRepayment = Number(repayments.borrow_repayment || 0);

    const totalOutgoing =
      totalExpenses +
      loanEmiPaid +
      loanRepayment +
      borrowRepayment;

    const savings = totalIncome - totalOutgoing;

    let financialStatus = "No Savings";

    if (savings > 0) {
      financialStatus = "Saved";
    } else if (savings < 0) {
      financialStatus = "Loss";
    } else {
      financialStatus = "No Savings";
    }

    if (totalIncome > totalOutgoing) {
      financialStatus = "Profit";
    }

    const response = {
      success: true,

      data: {
        month,

        business: {
          total: totalBusiness,
          payment: businessPayment,
        },

        work: {
          total: totalWorks,
          payment: workPayment,
        },

        income: {
          received: receivedPayments,
          work_received: Number(payments.received_work || 0),
          business_received: Number(payments.received_business || 0),
          other_received: Number(payments.received_other || 0),
          total: totalIncome,
        },

        expenses: {
          total: totalExpenses,
        },

        loan: {
          active_count: Number(upcoming.active_loans || 0),
          total_amount: Number(upcoming.total_loan_amount || 0),
          emi_paid: loanEmiPaid,
          repayment_paid: loanRepayment,
          next_due_date: upcoming.next_loan_date || null,
        },

        borrow: {
          active_count: Number(upcoming.active_borrows || 0),
          total_amount: Number(upcoming.total_borrow_amount || 0),
          repayment_paid: borrowRepayment,
          next_return_date: upcoming.next_borrow_date || null,
        },

        savings: {
          total_income: totalIncome,
          total_outgoing: totalOutgoing,
          total: savings,
          status: financialStatus,
        },

        other_income: {
          received: Number(payments.received_other || 0),
          exists: Number(payments.received_other || 0) > 0,
        },

        upcoming: {
          active_loans: Number(upcoming.active_loans || 0),
          active_borrows: Number(upcoming.active_borrows || 0),
          next_loan_date: upcoming.next_loan_date || null,
          next_borrow_return_date: upcoming.next_borrow_date || null,
        },
      },
    };

    return res.json(response);
  } catch (error) {
    console.error("❌ GET overview error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to load overview",
      error: error.message,
    });
  }
});

// ============================================================
// 2. CREATE BUSINESS / WORK
// These records remain available for separate Business/Work management.
// They do NOT override the 4 manual monthly overview values above.
// POST /api/overview/business-work
// ============================================================

router.post("/business-work", authenticate, async (req, res) => {
  try {
    const {
      name,
      type,
      status,
      amount,
      start_date,
      end_date,
      notes,
    } = req.body;

    const normalizedType = normalizeType(type);
    const normalizedStatus = normalizeStatus(status);
    const numericAmount =
      amount === undefined || amount === null || amount === ""
        ? 0
        : parsePositiveNumber(amount);

    if (!name || !String(name).trim()) {
      return res.status(400).json({
        success: false,
        message: "Business/Work name is required",
      });
    }

    if (!normalizedType) {
      return res.status(400).json({
        success: false,
        message: "Type must be Business or Work",
      });
    }

    if (!normalizedStatus) {
      return res.status(400).json({
        success: false,
        message: "Invalid status",
      });
    }

    if (numericAmount === null) {
      return res.status(400).json({
        success: false,
        message: "Amount must be a valid positive number",
      });
    }

    if (start_date && !isValidDate(start_date)) {
      return res.status(400).json({
        success: false,
        message: "Invalid start date",
      });
    }

    if (end_date && !isValidDate(end_date)) {
      return res.status(400).json({
        success: false,
        message: "Invalid end date",
      });
    }

    if (start_date && end_date && end_date < start_date) {
      return res.status(400).json({
        success: false,
        message: "End date cannot be before start date",
      });
    }

    const result = await db.query(
      `
      INSERT INTO personal_business_work (
        user_id,
        name,
        type,
        status,
        amount,
        start_date,
        end_date,
        notes
      )
      VALUES ($1,$2,$3,$4,$5,COALESCE($6::DATE,CURRENT_DATE),$7,$8)
      RETURNING *
      `,
      [
        req.userId,
        String(name).trim(),
        normalizedType,
        normalizedStatus,
        numericAmount,
        start_date || null,
        end_date || null,
        notes || null,
      ]
    );

    return res.status(201).json({
      success: true,
      message: `${normalizedType} added successfully`,
      data: result.rows[0],
    });
  } catch (error) {
    console.error("❌ Create business/work error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to add business/work",
      error: error.message,
    });
  }
});

// ============================================================
// 3. GET BUSINESS / WORK LIST
// GET /api/overview/business-work?type=Business&status=Active
// ============================================================

router.get("/business-work", authenticate, async (req, res) => {
  try {
    const { type, status, month } = req.query;

    const normalizedType = type ? normalizeType(type) : null;
    const normalizedStatus = status ? normalizeStatus(status) : null;

    if (type && !normalizedType) {
      return res.status(400).json({
        success: false,
        message: "Invalid type",
      });
    }

    if (status && !normalizedStatus) {
      return res.status(400).json({
        success: false,
        message: "Invalid status",
      });
    }

    let query = `
      SELECT
        id,
        name,
        type,
        status,
        amount,
        start_date,
        end_date,
        notes,
        created_at,
        updated_at
      FROM personal_business_work
      WHERE user_id = $1
    `;

    const values = [req.userId];
    let index = 2;

    if (normalizedType) {
      query += ` AND type = $${index}`;
      values.push(normalizedType);
      index++;
    }

    if (normalizedStatus) {
      query += ` AND status = $${index}`;
      values.push(normalizedStatus);
      index++;
    }

    if (month) {
      const range = getMonthRange(month);

      if (!range) {
        return res.status(400).json({
          success: false,
          message: "Invalid month. Use YYYY-MM.",
        });
      }

      query += `
        AND start_date < $${index}::DATE
        AND (
          end_date IS NULL
          OR end_date >= $${index + 1}::DATE
        )
      `;

      values.push(range.nextMonthStart);
      values.push(range.monthStart);
      index += 2;
    }

    query += " ORDER BY start_date DESC, id DESC";

    const result = await db.query(query, values);

    return res.json({
      success: true,
      count: result.rows.length,
      data: result.rows,
    });
  } catch (error) {
    console.error("❌ Get business/work error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch business/work",
      error: error.message,
    });
  }
});

// ============================================================
// 4. GET SINGLE BUSINESS / WORK
// GET /api/overview/business-work/:id
// ============================================================

router.get("/business-work/:id", authenticate, async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid business/work ID",
      });
    }

    const result = await db.query(
      `
      SELECT *
      FROM personal_business_work
      WHERE id = $1
        AND user_id = $2
      `,
      [id, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Business/Work not found",
      });
    }

    return res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    console.error("❌ Get single business/work error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch business/work",
      error: error.message,
    });
  }
});

// ============================================================
// 5. UPDATE BUSINESS / WORK
// PUT /api/overview/business-work/:id
// ============================================================

router.put("/business-work/:id", authenticate, async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid business/work ID",
      });
    }

    const existing = await db.query(
      `
      SELECT *
      FROM personal_business_work
      WHERE id = $1
        AND user_id = $2
      `,
      [id, req.userId]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Business/Work not found",
      });
    }

    const old = existing.rows[0];

    const {
      name,
      type,
      status,
      amount,
      start_date,
      end_date,
      notes,
    } = req.body;

    const finalName =
      name !== undefined ? String(name).trim() : old.name;

    const finalType =
      type !== undefined ? normalizeType(type) : old.type;

    const finalStatus =
      status !== undefined ? normalizeStatus(status) : old.status;

    const finalAmount =
      amount !== undefined
        ? parsePositiveNumber(amount)
        : Number(old.amount);

    const finalStartDate =
      start_date !== undefined ? start_date : old.start_date;

    const finalEndDate =
      end_date !== undefined ? end_date : old.end_date;

    const finalNotes =
      notes !== undefined ? notes : old.notes;

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

    if (finalAmount === null || finalAmount < 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid amount",
      });
    }

    if (!isValidDate(String(finalStartDate))) {
      return res.status(400).json({
        success: false,
        message: "Invalid start date",
      });
    }

    if (
      finalEndDate !== null &&
      finalEndDate !== undefined &&
      !isValidDate(String(finalEndDate))
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid end date",
      });
    }

    if (
      finalEndDate &&
      String(finalEndDate) < String(finalStartDate)
    ) {
      return res.status(400).json({
        success: false,
        message: "End date cannot be before start date",
      });
    }

    const result = await db.query(
      `
      UPDATE personal_business_work
      SET
        name = $1,
        type = $2,
        status = $3,
        amount = $4,
        start_date = $5,
        end_date = $6,
        notes = $7,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $8
        AND user_id = $9
      RETURNING *
      `,
      [
        finalName,
        finalType,
        finalStatus,
        finalAmount,
        finalStartDate,
        finalEndDate || null,
        finalNotes || null,
        id,
        req.userId,
      ]
    );

    return res.json({
      success: true,
      message: "Business/Work updated successfully",
      data: result.rows[0],
    });
  } catch (error) {
    console.error("❌ Update business/work error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to update business/work",
      error: error.message,
    });
  }
});

// ============================================================
// 6. DELETE BUSINESS / WORK
// DELETE /api/overview/business-work/:id
// ============================================================

router.delete("/business-work/:id", authenticate, async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid business/work ID",
      });
    }

    const result = await db.query(
      `
      DELETE FROM personal_business_work
      WHERE id = $1
        AND user_id = $2
      RETURNING id, name, type
      `,
      [id, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Business/Work not found",
      });
    }

    return res.json({
      success: true,
      message: "Business/Work deleted successfully",
      data: result.rows[0],
    });
  } catch (error) {
    console.error("❌ Delete business/work error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to delete business/work",
      error: error.message,
    });
  }
});

// ============================================================
// 7. UPDATE MONTHLY OVERVIEW MANUAL VALUES
// PUT /api/overview/month
//
// Use this only for monthly overview values that are not derived
// from Business/Work records. Financial totals remain calculated
// from the actual financial tables.
// ============================================================

router.put("/month", authenticate, async (req, res) => {
  try {
    const {
      month,
      total_business,
      total_works,
      business_payment,
      work_payment,
    } = req.body;

    const selectedMonth = month || getCurrentMonth();
    const range = getMonthRange(selectedMonth);

    if (!range) {
      return res.status(400).json({
        success: false,
        message: "Invalid month. Use YYYY-MM.",
      });
    }

    const businessCount = Number(total_business ?? 0);
    const workCount = Number(total_works ?? 0);
    const businessAmount = Number(business_payment ?? 0);
    const workAmount = Number(work_payment ?? 0);

    if (
      !Number.isInteger(businessCount) ||
      businessCount < 0 ||
      !Number.isInteger(workCount) ||
      workCount < 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Business/work totals must be valid non-negative integers",
      });
    }

    if (
      !Number.isFinite(businessAmount) ||
      businessAmount < 0 ||
      !Number.isFinite(workAmount) ||
      workAmount < 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Payment totals must be valid non-negative numbers",
      });
    }

    const result = await db.query(
      `
      INSERT INTO personal_overview (
        user_id,
        month_start,
        total_business,
        total_works,
        business_payment,
        work_payment
      )
      VALUES ($1,$2::DATE,$3,$4,$5,$6)
      ON CONFLICT (user_id, month_start)
      DO UPDATE SET
        total_business = EXCLUDED.total_business,
        total_works = EXCLUDED.total_works,
        business_payment = EXCLUDED.business_payment,
        work_payment = EXCLUDED.work_payment,
        updated_at = CURRENT_TIMESTAMP
      RETURNING *
      `,
      [
        req.userId,
        range.monthStart,
        businessCount,
        workCount,
        businessAmount,
        workAmount,
      ]
    );

    return res.json({
      success: true,
      message: "Monthly overview updated successfully",
      data: result.rows[0],
    });
  } catch (error) {
    console.error("❌ Update monthly overview error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to update monthly overview",
      error: error.message,
    });
  }
});

// ============================================================
// 8. GET MONTHLY BUSINESS / WORK SUMMARY
// GET /api/overview/monthly-summary?month=2026-08
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

    const result = await db.query(
      `
      SELECT
        type,
        COUNT(*)::INTEGER AS total_records,
        COUNT(*) FILTER (WHERE status = 'Active')::INTEGER AS active_records,
        COUNT(*) FILTER (WHERE status = 'Completed')::INTEGER AS completed_records,
        COUNT(*) FILTER (WHERE status = 'Paused')::INTEGER AS paused_records,
        COALESCE(SUM(amount), 0) AS total_amount
      FROM personal_business_work
      WHERE user_id = $1
        AND start_date < $2::DATE
        AND (
          end_date IS NULL
          OR end_date >= $3::DATE
        )
      GROUP BY type
      ORDER BY type
      `,
      [req.userId, range.nextMonthStart, range.monthStart]
    );

    return res.json({
      success: true,
      month,
      data: result.rows,
    });
  } catch (error) {
    console.error("❌ Monthly overview summary error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch monthly overview summary",
      error: error.message,
    });
  }
});

// ============================================================
// 9. GET UPCOMING LOANS / BORROWS
// GET /api/overview/upcoming
//
// Used by Overview to show future repayments/returns.
// ============================================================

router.get("/upcoming", authenticate, async (req, res) => {
  try {
    const result = await db.query(
      `
      SELECT
        id,
        name,
        type,
        amount,
        emi,
        start_date,
        end_date,
        return_date,
        status,
        notes,

        CASE
          WHEN type = 'Loan' THEN end_date
          ELSE return_date
        END AS due_date,

        CASE
          WHEN type = 'Loan' THEN
            GREATEST(
              0,
              (end_date - CURRENT_DATE)
            )
          ELSE
            GREATEST(
              0,
              (return_date - CURRENT_DATE)
            )
        END AS remaining_days

      FROM personal_loans_borrow
      WHERE user_id = $1
        AND status = 'Active'
        AND (
          (type = 'Loan' AND end_date >= CURRENT_DATE)
          OR
          (type = 'Borrow' AND return_date >= CURRENT_DATE)
        )
      ORDER BY due_date ASC, id ASC
      `,
      [req.userId]
    );

    return res.json({
      success: true,
      count: result.rows.length,
      data: result.rows,
    });
  } catch (error) {
    console.error("❌ Upcoming loan/borrow error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch upcoming loan/borrow records",
      error: error.message,
    });
  }
});

// ============================================================
// 10. DELETE MONTHLY OVERVIEW
// DELETE /api/overview/month/:month
// ============================================================

router.delete("/month/:month", authenticate, async (req, res) => {
  try {
    const range = getMonthRange(req.params.month);

    if (!range) {
      return res.status(400).json({
        success: false,
        message: "Invalid month. Use YYYY-MM.",
      });
    }

    const result = await db.query(
      `
      DELETE FROM personal_overview
      WHERE user_id = $1
        AND month_start = $2::DATE
      RETURNING *
      `,
      [req.userId, range.monthStart]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Monthly overview not found",
      });
    }

    return res.json({
      success: true,
      message: "Monthly overview deleted successfully",
      data: result.rows[0],
    });
  } catch (error) {
    console.error("❌ Delete monthly overview error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to delete monthly overview",
      error: error.message,
    });
  }
});

// ============================================================
// EXPORT
// ============================================================

module.exports = router;