// routes/summaryApi.js
// Summary API
// Selected-month complete financial summary
// Income + expenses + EMI/loan + borrow repayment
// Net profit/loss + savings + professional pie-chart data
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

  return `${now.getFullYear()}-${String(
    now.getMonth() + 1
  ).padStart(2, "0")}`;
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

const toNumber = (value) => Number(value || 0);

const getStatus = (income, outgoing) => {
  const net = income - outgoing;

  if (income === 0 && outgoing === 0) {
    return "No Activity";
  }

  if (net > 0) return "Profit";
  if (net < 0) return "Loss";

  return "Break Even";
};

// ============================================================
// MAIN SUMMARY
// GET /api/summary?month=2026-08
//
// User logic:
// 1. Total income = all received payments.
// 2. Total expense = selected month's expenses.
// 3. EMI / loan repayment = selected month's actual repayments.
// 4. Borrow repayment = selected month's actual borrow repayments.
// 5. Net = income - all outgoing.
// 6. Savings = positive net amount.
// 7. Profit / Loss status.
// 8. Pending / overdue / lost payments.
// 9. Pie chart data.
// ============================================================

router.get("/", authenticate, async (req, res) => {
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

    // ========================================================
    // Run all independent queries together.
    // ========================================================

    const [
      paymentResult,
      expenseResult,
      repaymentResult,
      loanBorrowResult,
    ] = await Promise.all([
      // ------------------------------------------------------
      // Payments
      // ------------------------------------------------------

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

      // ------------------------------------------------------
      // Expenses
      // ------------------------------------------------------

      db.query(
        `
        SELECT
          COALESCE(SUM(amount), 0) AS total_expense,
          COUNT(*)::INTEGER AS expense_count
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

      // ------------------------------------------------------
      // Loan / Borrow repayments
      // ------------------------------------------------------

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

      // ------------------------------------------------------
      // Current outstanding Loan / Borrow information
      // ------------------------------------------------------

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
    ]);

    const payment = paymentResult.rows[0];
    const expense = expenseResult.rows[0];
    const repayment = repaymentResult.rows[0];
    const loanBorrow = loanBorrowResult.rows[0];

    // ========================================================
    // Income
    // ========================================================

    const totalIncome =
      toNumber(payment.received);

    // ========================================================
    // Expenses
    // ========================================================

    const totalExpense =
      toNumber(expense.total_expense);

    // ========================================================
    // Loan / EMI
    // ========================================================

    const emiPaid =
      toNumber(repayment.emi_paid);

    const loanRepayment =
      toNumber(repayment.loan_repayment);

    // ========================================================
    // Borrow repayment
    // ========================================================

    const borrowRepayment =
      toNumber(repayment.borrow_repayment);

    // ========================================================
    // Total outgoing
    //
    // Expense + EMI + Loan Repayment + Borrow Repayment
    // ========================================================

    const totalLoanOutgoing =
      emiPaid + loanRepayment;

    const totalOutgoing =
      totalExpense +
      totalLoanOutgoing +
      borrowRepayment;

    // ========================================================
    // Net result
    // ========================================================

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

    // ========================================================
    // Pie chart
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
        label: "EMI / Loan",
        value: totalLoanOutgoing,
      },
      {
        label: "Borrow Repayment",
        value: borrowRepayment,
      },
    ];

    // ========================================================
    // Payment status chart
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
    ];

    // ========================================================
    // Final response
    // ========================================================

    return res.json({
      success: true,

      month,

      income: {
        total: totalIncome,
        received_count: Number(
          payment.received_count || 0
        ),
      },

      expenses: {
        total: totalExpense,
        count: Number(
          expense.expense_count || 0
        ),
      },

      loan: {
        emi_paid: emiPaid,

        loan_repayment: loanRepayment,

        total_loan_outgoing:
          totalLoanOutgoing,
      },

      borrow: {
        repayment: borrowRepayment,
      },

      payments: {
        received: toNumber(payment.received),
        pending: toNumber(payment.pending),
        overdue: toNumber(payment.overdue),
        lost: toNumber(payment.lost),

        received_count: Number(
          payment.received_count || 0
        ),

        pending_count: Number(
          payment.pending_count || 0
        ),

        overdue_count: Number(
          payment.overdue_count || 0
        ),

        lost_count: Number(
          payment.lost_count || 0
        ),

        total_count: Number(
          payment.total_count || 0
        ),
      },

      outstanding: {
        active_loan_total: toNumber(
          loanBorrow.active_loan_total
        ),

        active_borrow_total: toNumber(
          loanBorrow.active_borrow_total
        ),

        active_loan_count: Number(
          loanBorrow.active_loan_count || 0
        ),

        active_borrow_count: Number(
          loanBorrow.active_borrow_count || 0
        ),

        overdue_loan_count: Number(
          loanBorrow.overdue_loan_count || 0
        ),

        overdue_borrow_count: Number(
          loanBorrow.overdue_borrow_count || 0
        ),
      },

      totals: {
        total_income: totalIncome,

        total_expense: totalExpense,

        total_emi:
          emiPaid,

        total_loan_repayment:
          loanRepayment,

        total_borrow_repayment:
          borrowRepayment,

        total_outgoing:
          totalOutgoing,

        net:
          netAmount,

        savings,

        loss,

        status,
      },

      chart: {
        pie: pieChart,
        payment_status: paymentStatusChart,
      },
    });
  } catch (error) {
    console.error("❌ Summary API error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to calculate summary",
      error: error.message,
    });
  }
});

// ============================================================
// 2. CATEGORY EXPENSE SUMMARY
// GET /api/summary/expense-categories?month=2026-08
//
// Useful for the Summary page category pie chart.
// ============================================================

router.get(
  "/expense-categories",
  authenticate,
  async (req, res) => {
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
          count: Number(row.count || 0),
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
//
// Compares selected month with previous month.
// ============================================================

router.get(
  "/compare",
  authenticate,
  async (req, res) => {
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

      const [year, monthNumber] =
        month.split("-").map(Number);

      const previousDate = new Date(
        Date.UTC(
          year,
          monthNumber - 2,
          1
        )
      );

      const previousMonth =
        `${previousDate.getUTCFullYear()}-${String(
          previousDate.getUTCMonth() + 1
        ).padStart(2, "0")}`;

      const previousRange =
        getMonthRange(previousMonth);

      const getMonthTotals = async (
        monthRange
      ) => {
        const [
          payment,
          expense,
          repayment,
        ] = await Promise.all([
          db.query(
            `
            SELECT COALESCE(
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
            SELECT COALESCE(SUM(amount),0) AS expense
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
            SELECT COALESCE(SUM(amount),0) AS repayment
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
        ]);

        const income =
          toNumber(payment.rows[0].income);

        const expenseTotal =
          toNumber(expense.rows[0].expense);

        const repaymentTotal =
          toNumber(repayment.rows[0].repayment);

        const outgoing =
          expenseTotal +
          repaymentTotal;

        return {
          income,
          expense: expenseTotal,
          repayment: repaymentTotal,
          outgoing,
          net: income - outgoing,
        };
      };

      const [current, previous] =
        await Promise.all([
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