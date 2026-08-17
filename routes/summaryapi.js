// routes/summaryApi.js
// Complete Summary API
// Uses:
// personal_users
// personal_business_work
// personal_expenses
// personal_loans_borrow
// personal_loan_emi_payments
// personal_payments
//
// Endpoints:
// GET /api/summary?month=YYYY-MM
// GET /api/summary/expense-categories?month=YYYY-MM
// GET /api/summary/compare?month=YYYY-MM

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
    const header = String(req.headers.authorization || "");

    if (!header.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Authentication token required",
      });
    }

    const token = header.slice(7).trim();

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Authentication token required",
      });
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    const userId = Number(decoded?.id);

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(401).json({
        success: false,
        message: "Invalid authentication token",
      });
    }

    req.userId = userId;
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

  return `${now.getFullYear()}-${String(
    now.getMonth() + 1
  ).padStart(2, "0")}`;
};

const getMonthRange = (month) => {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || ""))) {
    return null;
  }

  const [year, monthNumber] = String(month)
    .split("-")
    .map(Number);

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

const toNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

const getStatus = (income, outgoing) => {
  const net = income - outgoing;

  if (income === 0 && outgoing === 0) {
    return "No Activity";
  }

  if (net > 0) return "Profit";
  if (net < 0) return "Loss";

  return "Break Even";
};

const getPreviousMonth = (month) => {
  const [year, monthNumber] = month.split("-").map(Number);

  const date = new Date(
    Date.UTC(year, monthNumber - 2, 1)
  );

  return `${date.getUTCFullYear()}-${String(
    date.getUTCMonth() + 1
  ).padStart(2, "0")}`;
};

const safeCount = (value) => Number(value || 0);

// ============================================================
// 1. MAIN SUMMARY
// GET /api/summary?month=2026-08
// ============================================================

router.get("/", authenticate, async (req, res) => {
  try {
    const month = String(
      req.query.month || getCurrentMonth()
    );

    const range = getMonthRange(month);

    if (!range) {
      return res.status(400).json({
        success: false,
        message: "Invalid month. Use YYYY-MM.",
      });
    }

    // IMPORTANT:
    // Every db.query() below uses exactly:
    // db.query(sql, values)
    //
    // No callback argument is passed.
    // This prevents the pg-pool:
    // "TypeError: cb is not a function" error.

    const [
      paymentResult,
      expenseResult,
      repaymentResult,
      loanBorrowResult,
      businessWorkResult,
    ] = await Promise.all([
      // --------------------------------------------------------
      // PAYMENTS
      // --------------------------------------------------------

      db.query(
        `
        SELECT
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
      ),

      // --------------------------------------------------------
      // EXPENSES
      // --------------------------------------------------------

      db.query(
        `
        SELECT
          COALESCE(SUM(amount), 0) AS total_expense,
          COUNT(*)::INTEGER AS expense_count,
          COUNT(DISTINCT category)::INTEGER AS category_count

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
      ),

      // --------------------------------------------------------
      // EMI / LOAN / BORROW REPAYMENTS
      // --------------------------------------------------------

      db.query(
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

          COALESCE(SUM(amount), 0) AS total_repayment,

          COUNT(*)::INTEGER AS repayment_count

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
      ),

      // --------------------------------------------------------
      // LOAN / BORROW OUTSTANDING
      // --------------------------------------------------------

      db.query(
        `
        SELECT
          COALESCE(
            SUM(amount) FILTER (
              WHERE type = 'Loan'
                AND status = 'Active'
            ),
            0
          ) AS active_loan_total,

          COALESCE(
            SUM(amount) FILTER (
              WHERE type = 'Borrow'
                AND status = 'Active'
            ),
            0
          ) AS active_borrow_total,

          COUNT(*) FILTER (
            WHERE type = 'Loan'
              AND status = 'Active'
          )::INTEGER AS active_loan_count,

          COUNT(*) FILTER (
            WHERE type = 'Borrow'
              AND status = 'Active'
          )::INTEGER AS active_borrow_count,

          COUNT(*) FILTER (
            WHERE type = 'Loan'
              AND status = 'Overdue'
          )::INTEGER AS overdue_loan_count,

          COUNT(*) FILTER (
            WHERE type = 'Borrow'
              AND status = 'Overdue'
          )::INTEGER AS overdue_borrow_count

        FROM personal_loans_borrow

        WHERE user_id = $1
        `,
        [req.userId]
      ),

      // --------------------------------------------------------
      // BUSINESS / WORK
      //
      // Uses records active during the selected month.
      // Amount totals are grouped by type.
      // --------------------------------------------------------

      db.query(
        `
        SELECT
          COALESCE(
            SUM(amount) FILTER (
              WHERE type = 'Business'
            ),
            0
          ) AS business_total,

          COALESCE(
            SUM(amount) FILTER (
              WHERE type = 'Work'
            ),
            0
          ) AS work_total,

          COUNT(*) FILTER (
            WHERE type = 'Business'
          )::INTEGER AS business_count,

          COUNT(*) FILTER (
            WHERE type = 'Work'
          )::INTEGER AS work_count,

          COUNT(*) FILTER (
            WHERE status = 'Active'
          )::INTEGER AS active_count,

          COUNT(*) FILTER (
            WHERE status = 'Completed'
          )::INTEGER AS completed_count,

          COUNT(*) FILTER (
            WHERE status = 'Paused'
          )::INTEGER AS paused_count

        FROM personal_business_work

        WHERE user_id = $1
          AND start_date < $2::DATE
          AND (
            end_date IS NULL
            OR end_date >= $3::DATE
          )
        `,
        [
          req.userId,
          range.nextMonthStart,
          range.monthStart,
        ]
      ),
    ]);

    const payment = paymentResult.rows[0] || {};
    const expense = expenseResult.rows[0] || {};
    const repayment = repaymentResult.rows[0] || {};
    const loanBorrow = loanBorrowResult.rows[0] || {};
    const businessWork = businessWorkResult.rows[0] || {};

    // ========================================================
    // CALCULATIONS
    // ========================================================

    const totalIncome = toNumber(payment.received);

    const totalExpense = toNumber(
      expense.total_expense
    );

    const emiPaid = toNumber(
      repayment.emi_paid
    );

    const loanRepayment = toNumber(
      repayment.loan_repayment
    );

    const borrowRepayment = toNumber(
      repayment.borrow_repayment
    );

    const totalLoanOutgoing =
      emiPaid + loanRepayment;

    const totalOutgoing =
      totalExpense +
      totalLoanOutgoing +
      borrowRepayment;

    const netAmount =
      totalIncome - totalOutgoing;

    const savings =
      Math.max(0, netAmount);

    const loss =
      Math.max(0, -netAmount);

    const status =
      getStatus(
        totalIncome,
        totalOutgoing
      );

    const businessTotal =
      toNumber(businessWork.business_total);

    const workTotal =
      toNumber(businessWork.work_total);

    // ========================================================
    // MAIN PIE CHART
    // ========================================================

    const pieChart = [
      {
        label: "Income",
        value: totalIncome,
      },
      {
        label: "Expenses",
        value: totalExpense,
      },
      {
        label: "EMI",
        value: emiPaid,
      },
      {
        label: "Loan Repayment",
        value: loanRepayment,
      },
      {
        label: "Borrow Repayment",
        value: borrowRepayment,
      },
      {
        label: "Business",
        value: businessTotal,
      },
      {
        label: "Work",
        value: workTotal,
      },
    ].filter((item) => item.value > 0);

    // ========================================================
    // PAYMENT STATUS CHART
    // ========================================================

    const paymentStatusChart = [
      {
        label: "Received",
        value: toNumber(payment.received),
      },
      {
        label: "Pending",
        value: toNumber(payment.pending),
      },
      {
        label: "Overdue",
        value: toNumber(payment.overdue),
      },
      {
        label: "Lost",
        value: toNumber(payment.lost),
      },
    ].filter((item) => item.value > 0);

    return res.json({
      success: true,
      month,

      totals: {
        total_income: totalIncome,
        total_expense: totalExpense,
        total_emi: emiPaid,
        total_loan_repayment: loanRepayment,
        total_borrow_repayment: borrowRepayment,
        total_outgoing: totalOutgoing,
        net: netAmount,
        savings,
        loss,
        status,
      },

      income: {
        received: totalIncome,
        received_count: safeCount(
          payment.received_count
        ),
      },

      expenses: {
        total: totalExpense,
        count: safeCount(
          expense.expense_count
        ),
        categories: safeCount(
          expense.category_count
        ),
      },

      loan: {
        emi: emiPaid,
        repayment: loanRepayment,
        total_loan_outgoing:
          totalLoanOutgoing,
      },

      borrow: {
        repayment: borrowRepayment,
      },

      business_work: {
        business_total: businessTotal,
        work_total: workTotal,

        business_count:
          safeCount(
            businessWork.business_count
          ),

        work_count:
          safeCount(
            businessWork.work_count
          ),

        active_count:
          safeCount(
            businessWork.active_count
          ),

        completed_count:
          safeCount(
            businessWork.completed_count
          ),

        paused_count:
          safeCount(
            businessWork.paused_count
          ),
      },

      payments: {
        received: toNumber(
          payment.received
        ),

        pending: toNumber(
          payment.pending
        ),

        overdue: toNumber(
          payment.overdue
        ),

        lost: toNumber(
          payment.lost
        ),

        received_count:
          safeCount(
            payment.received_count
          ),

        pending_count:
          safeCount(
            payment.pending_count
          ),

        overdue_count:
          safeCount(
            payment.overdue_count
          ),

        lost_count:
          safeCount(
            payment.lost_count
          ),

        total_count:
          safeCount(
            payment.total_count
          ),
      },

      outstanding: {
        active_loan_total:
          toNumber(
            loanBorrow.active_loan_total
          ),

        active_borrow_total:
          toNumber(
            loanBorrow.active_borrow_total
          ),

        active_loan_count:
          safeCount(
            loanBorrow.active_loan_count
          ),

        active_borrow_count:
          safeCount(
            loanBorrow.active_borrow_count
          ),

        overdue_loan_count:
          safeCount(
            loanBorrow.overdue_loan_count
          ),

        overdue_borrow_count:
          safeCount(
            loanBorrow.overdue_borrow_count
          ),
      },

      chart: {
        pie: pieChart,
        payment_status:
          paymentStatusChart,
      },
    });
  } catch (error) {
    console.error(
      "❌ Summary API error:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Failed to calculate summary",
      error: error.message,
    });
  }
});

// ============================================================
// 2. EXPENSE CATEGORY SUMMARY
// GET /api/summary/expense-categories?month=2026-08
// ============================================================

router.get(
  "/expense-categories",
  authenticate,
  async (req, res) => {
    try {
      const month = String(
        req.query.month || getCurrentMonth()
      );

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

      return res.json({
        success: true,
        month,

        data: result.rows.map((row) => ({
          category: row.category,
          total: toNumber(row.total),
          count: safeCount(row.count),
        })),
      });
    } catch (error) {
      console.error(
        "❌ Summary expense category error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Failed to calculate expense categories",
        error: error.message,
      });
    }
  }
);

// ============================================================
// 3. MONTH COMPARISON
// GET /api/summary/compare?month=2026-08
// ============================================================

router.get(
  "/compare",
  authenticate,
  async (req, res) => {
    try {
      const month = String(
        req.query.month || getCurrentMonth()
      );

      const range = getMonthRange(month);

      if (!range) {
        return res.status(400).json({
          success: false,
          message: "Invalid month. Use YYYY-MM.",
        });
      }

      const previousMonth =
        getPreviousMonth(month);

      const previousRange =
        getMonthRange(previousMonth);

      // ------------------------------------------------------
      // Helper for one month's comparison totals.
      // ------------------------------------------------------

      const getMonthTotals = async (
        monthRange
      ) => {
        const [
          paymentResult,
          expenseResult,
          repaymentResult,
          businessWorkResult,
        ] = await Promise.all([
          db.query(
            `
            SELECT
              COALESCE(
                SUM(amount) FILTER (
                  WHERE status = 'Received'
                ),
                0
              ) AS income

            FROM personal_payments

            WHERE user_id = $1
              AND payment_date >= $2::DATE
              AND payment_date < $3::DATE
            `,
            [
              req.userId,
              monthRange.monthStart,
              monthRange.nextMonthStart,
            ]
          ),

          db.query(
            `
            SELECT
              COALESCE(SUM(amount), 0) AS expense

            FROM personal_expenses

            WHERE user_id = $1
              AND expense_date >= $2::DATE
              AND expense_date < $3::DATE
            `,
            [
              req.userId,
              monthRange.monthStart,
              monthRange.nextMonthStart,
            ]
          ),

          db.query(
            `
            SELECT
              COALESCE(SUM(amount), 0) AS repayment

            FROM personal_loan_emi_payments

            WHERE user_id = $1
              AND payment_date >= $2::DATE
              AND payment_date < $3::DATE
            `,
            [
              req.userId,
              monthRange.monthStart,
              monthRange.nextMonthStart,
            ]
          ),

          db.query(
            `
            SELECT
              COALESCE(
                SUM(amount) FILTER (
                  WHERE type = 'Business'
                ),
                0
              ) AS business,

              COALESCE(
                SUM(amount) FILTER (
                  WHERE type = 'Work'
                ),
                0
              ) AS work

            FROM personal_business_work

            WHERE user_id = $1
              AND start_date < $2::DATE
              AND (
                end_date IS NULL
                OR end_date >= $3::DATE
              )
            `,
            [
              req.userId,
              monthRange.nextMonthStart,
              monthRange.monthStart,
            ]
          ),
        ]);

        const income =
          toNumber(
            paymentResult.rows[0]?.income
          );

        const expense =
          toNumber(
            expenseResult.rows[0]?.expense
          );

        const repayment =
          toNumber(
            repaymentResult.rows[0]?.repayment
          );

        const business =
          toNumber(
            businessWorkResult.rows[0]?.business
          );

        const work =
          toNumber(
            businessWorkResult.rows[0]?.work
          );

        const outgoing =
          expense + repayment;

        return {
          income,
          expense,
          repayment,
          business,
          work,
          outgoing,
          net: income - outgoing,
        };
      };

      const [
        current,
        previous,
      ] = await Promise.all([
        getMonthTotals(range),
        getMonthTotals(previousRange),
      ]);

      const percentageChange = (
        currentValue,
        previousValue
      ) => {
        if (previousValue === 0) {
          return currentValue === 0
            ? 0
            : null;
        }

        return Number(
          (
            ((currentValue - previousValue) /
              Math.abs(previousValue)) *
            100
          ).toFixed(2)
        );
      };

      return res.json({
        success: true,

        current_month: {
          month,
          ...current,
        },

        previous_month: {
          month: previousMonth,
          ...previous,
        },

        change: {
          income: percentageChange(
            current.income,
            previous.income
          ),

          expense: percentageChange(
            current.expense,
            previous.expense
          ),

          repayment: percentageChange(
            current.repayment,
            previous.repayment
          ),

          business: percentageChange(
            current.business,
            previous.business
          ),

          work: percentageChange(
            current.work,
            previous.work
          ),

          net: percentageChange(
            current.net,
            previous.net
          ),
        },
      });
    } catch (error) {
      console.error(
        "❌ Summary comparison error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Failed to compare monthly summary",
        error: error.message,
      });
    }
  }
);

// ============================================================
// EXPORT
// ============================================================

module.exports = router;