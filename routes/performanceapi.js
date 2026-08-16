// routes/performanceApi.js
// Performance API
// Weekly + monthly financial performance
// Uses data from Expenses, Loan/Borrow repayments and Payments.
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

const toNumber = (value) => Number(value || 0);

const emptyWeek = (week) => ({
  week,

  expenses: 0,

  loan_emi: 0,
  loan_repayment: 0,
  borrow_repayment: 0,
  total_repayment: 0,

  received_payment: 0,
  pending_payment: 0,
  overdue_payment: 0,
  lost_payment: 0,

  total_income: 0,
  total_outgoing: 0,

  net: 0,
  status: "No Activity",
});

// ============================================================
// 1. WEEKLY PERFORMANCE
// GET /api/performance/weekly?month=2026-08
//
// Week definition:
// Week 1 = 1-7
// Week 2 = 8-14
// Week 3 = 15-21
// Week 4 = 22-28
// Week 5 = 29-end
//
// Includes:
// Expenses
// Loan/borrow repayments
// Received/pending/overdue/lost payments
// Net result
// ============================================================

router.get("/weekly", authenticate, async (req, res) => {
  try {
    const month = req.query.month || getCurrentMonth();
    const range = getMonthRange(month);

    if (!range) {
      return res.status(400).json({
        success: false,
        message: "Invalid month. Use YYYY-MM.",
      });
    }

    const weeks = [1, 2, 3, 4, 5].map(emptyWeek);

    // --------------------------------------------------------
    // Expenses
    // --------------------------------------------------------

    const expenseResult = await db.query(
      `
      SELECT
        CASE
          WHEN EXTRACT(DAY FROM expense_date) BETWEEN 1 AND 7
            THEN 1
          WHEN EXTRACT(DAY FROM expense_date) BETWEEN 8 AND 14
            THEN 2
          WHEN EXTRACT(DAY FROM expense_date) BETWEEN 15 AND 21
            THEN 3
          WHEN EXTRACT(DAY FROM expense_date) BETWEEN 22 AND 28
            THEN 4
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

    expenseResult.rows.forEach((row) => {
      const week = Number(row.week);

      if (weeks[week - 1]) {
        weeks[week - 1].expenses = toNumber(row.total);
      }
    });

    // --------------------------------------------------------
    // Loan / Borrow repayments
    // --------------------------------------------------------

    const repaymentResult = await db.query(
      `
      SELECT
        CASE
          WHEN EXTRACT(DAY FROM payment_date) BETWEEN 1 AND 7
            THEN 1
          WHEN EXTRACT(DAY FROM payment_date) BETWEEN 8 AND 14
            THEN 2
          WHEN EXTRACT(DAY FROM payment_date) BETWEEN 15 AND 21
            THEN 3
          WHEN EXTRACT(DAY FROM payment_date) BETWEEN 22 AND 28
            THEN 4
          ELSE 5
        END AS week,

        COALESCE(
          SUM(amount) FILTER (
            WHERE payment_type = 'EMI'
          ),
          0
        ) AS loan_emi,

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

      GROUP BY week
      ORDER BY week
      `,
      [
        req.userId,
        range.monthStart,
        range.nextMonthStart,
      ]
    );

    repaymentResult.rows.forEach((row) => {
      const week = Number(row.week);

      if (weeks[week - 1]) {
        weeks[week - 1].loan_emi =
          toNumber(row.loan_emi);

        weeks[week - 1].loan_repayment =
          toNumber(row.loan_repayment);

        weeks[week - 1].borrow_repayment =
          toNumber(row.borrow_repayment);

        weeks[week - 1].total_repayment =
          toNumber(row.total_repayment);
      }
    });

    // --------------------------------------------------------
    // Payments
    // --------------------------------------------------------

    const paymentResult = await db.query(
      `
      SELECT
        CASE
          WHEN EXTRACT(DAY FROM payment_date) BETWEEN 1 AND 7
            THEN 1
          WHEN EXTRACT(DAY FROM payment_date) BETWEEN 8 AND 14
            THEN 2
          WHEN EXTRACT(DAY FROM payment_date) BETWEEN 15 AND 21
            THEN 3
          WHEN EXTRACT(DAY FROM payment_date) BETWEEN 22 AND 28
            THEN 4
          ELSE 5
        END AS week,

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
        ) AS lost

      FROM personal_payments

      WHERE user_id = $1
        AND payment_date >= $2::DATE
        AND payment_date < $3::DATE

      GROUP BY week
      ORDER BY week
      `,
      [
        req.userId,
        range.monthStart,
        range.nextMonthStart,
      ]
    );

    paymentResult.rows.forEach((row) => {
      const week = Number(row.week);

      if (weeks[week - 1]) {
        weeks[week - 1].received_payment =
          toNumber(row.received);

        weeks[week - 1].pending_payment =
          toNumber(row.pending);

        weeks[week - 1].overdue_payment =
          toNumber(row.overdue);

        weeks[week - 1].lost_payment =
          toNumber(row.lost);
      }
    });

    // --------------------------------------------------------
    // Calculate final weekly results
    // --------------------------------------------------------

    weeks.forEach((week) => {
      week.total_income = week.received_payment;

      week.total_outgoing =
        week.expenses +
        week.loan_emi +
        week.loan_repayment +
        week.borrow_repayment;

      week.net =
        week.total_income -
        week.total_outgoing;

      if (
        week.total_income === 0 &&
        week.total_outgoing === 0
      ) {
        week.status = "No Activity";
      } else if (week.net > 0) {
        week.status = "Profit";
      } else if (week.net < 0) {
        week.status = "Loss";
      } else {
        week.status = "Break Even";
      }
    });

    // --------------------------------------------------------
    // Monthly totals from weekly data
    // --------------------------------------------------------

    const totals = weeks.reduce(
      (acc, week) => {
        acc.expenses += week.expenses;
        acc.loan_emi += week.loan_emi;
        acc.loan_repayment += week.loan_repayment;
        acc.borrow_repayment += week.borrow_repayment;
        acc.total_repayment += week.total_repayment;

        acc.received_payment += week.received_payment;
        acc.pending_payment += week.pending_payment;
        acc.overdue_payment += week.overdue_payment;
        acc.lost_payment += week.lost_payment;

        acc.total_income += week.total_income;
        acc.total_outgoing += week.total_outgoing;
        acc.net += week.net;

        return acc;
      },
      {
        expenses: 0,
        loan_emi: 0,
        loan_repayment: 0,
        borrow_repayment: 0,
        total_repayment: 0,
        received_payment: 0,
        pending_payment: 0,
        overdue_payment: 0,
        lost_payment: 0,
        total_income: 0,
        total_outgoing: 0,
        net: 0,
      }
    );

    let monthlyStatus = "No Activity";

    if (
      totals.total_income === 0 &&
      totals.total_outgoing === 0
    ) {
      monthlyStatus = "No Activity";
    } else if (totals.net > 0) {
      monthlyStatus = "Profit";
    } else if (totals.net < 0) {
      monthlyStatus = "Loss";
    } else {
      monthlyStatus = "Break Even";
    }

    return res.json({
      success: true,

      month,

      weekly: weeks,

      totals: {
        ...totals,
        status: monthlyStatus,
      },

      chart: {
        income: totals.total_income,
        expenses: totals.expenses,
        loan_repayment:
          totals.loan_emi +
          totals.loan_repayment,
        borrow_repayment:
          totals.borrow_repayment,
      },
    });
  } catch (error) {
    console.error("❌ Weekly performance error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to calculate weekly performance",
      error: error.message,
    });
  }
});

// ============================================================
// 2. MONTHLY PERFORMANCE
// GET /api/performance/monthly?year=2026
//
// All months of selected year.
// Useful for the monthly performance chart.
// ============================================================

router.get("/monthly", authenticate, async (req, res) => {
  try {
    const year = Number(
      req.query.year ||
      new Date().getFullYear()
    );

    if (
      !Number.isInteger(year) ||
      year < 2000 ||
      year > 2100
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid year",
      });
    }

    const yearStart = `${year}-01-01`;
    const nextYearStart = `${year + 1}-01-01`;

    const months = Array.from(
      { length: 12 },
      (_, index) => {
        return {
          month: index + 1,
          month_name: new Date(
            Date.UTC(year, index, 1)
          ).toLocaleString("en-US", {
            month: "long",
            timeZone: "UTC",
          }),

          income: 0,
          expenses: 0,
          loan_emi: 0,
          loan_repayment: 0,
          borrow_repayment: 0,

          total_outgoing: 0,
          net: 0,
          status: "No Activity",
        };
      }
    );

    // --------------------------------------------------------
    // Received payments by month
    // --------------------------------------------------------

    const paymentResult = await db.query(
      `
      SELECT
        EXTRACT(MONTH FROM payment_date)::INTEGER AS month,

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

      GROUP BY month
      ORDER BY month
      `,
      [
        req.userId,
        yearStart,
        nextYearStart,
      ]
    );

    paymentResult.rows.forEach((row) => {
      const month = Number(row.month);

      if (months[month - 1]) {
        months[month - 1].income =
          toNumber(row.income);
      }
    });

    // --------------------------------------------------------
    // Expenses by month
    // --------------------------------------------------------

    const expenseResult = await db.query(
      `
      SELECT
        EXTRACT(MONTH FROM expense_date)::INTEGER AS month,

        COALESCE(SUM(amount), 0) AS expenses

      FROM personal_expenses

      WHERE user_id = $1
        AND expense_date >= $2::DATE
        AND expense_date < $3::DATE

      GROUP BY month
      ORDER BY month
      `,
      [
        req.userId,
        yearStart,
        nextYearStart,
      ]
    );

    expenseResult.rows.forEach((row) => {
      const month = Number(row.month);

      if (months[month - 1]) {
        months[month - 1].expenses =
          toNumber(row.expenses);
      }
    });

    // --------------------------------------------------------
    // Loan / Borrow repayments by month
    // --------------------------------------------------------

    const repaymentResult = await db.query(
      `
      SELECT
        EXTRACT(MONTH FROM payment_date)::INTEGER AS month,

        COALESCE(
          SUM(amount) FILTER (
            WHERE payment_type = 'EMI'
          ),
          0
        ) AS loan_emi,

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

      GROUP BY month
      ORDER BY month
      `,
      [
        req.userId,
        yearStart,
        nextYearStart,
      ]
    );

    repaymentResult.rows.forEach((row) => {
      const month = Number(row.month);

      if (months[month - 1]) {
        months[month - 1].loan_emi =
          toNumber(row.loan_emi);

        months[month - 1].loan_repayment =
          toNumber(row.loan_repayment);

        months[month - 1].borrow_repayment =
          toNumber(row.borrow_repayment);
      }
    });

    // --------------------------------------------------------
    // Calculate monthly totals
    // --------------------------------------------------------

    months.forEach((month) => {
      month.total_outgoing =
        month.expenses +
        month.loan_emi +
        month.loan_repayment +
        month.borrow_repayment;

      month.net =
        month.income -
        month.total_outgoing;

      if (
        month.income === 0 &&
        month.total_outgoing === 0
      ) {
        month.status = "No Activity";
      } else if (month.net > 0) {
        month.status = "Profit";
      } else if (month.net < 0) {
        month.status = "Loss";
      } else {
        month.status = "Break Even";
      }
    });

    const totals = months.reduce(
      (acc, month) => {
        acc.income += month.income;
        acc.expenses += month.expenses;
        acc.loan_emi += month.loan_emi;
        acc.loan_repayment += month.loan_repayment;
        acc.borrow_repayment += month.borrow_repayment;
        acc.total_outgoing += month.total_outgoing;
        acc.net += month.net;

        return acc;
      },
      {
        income: 0,
        expenses: 0,
        loan_emi: 0,
        loan_repayment: 0,
        borrow_repayment: 0,
        total_outgoing: 0,
        net: 0,
      }
    );

    let status = "No Activity";

    if (
      totals.income === 0 &&
      totals.total_outgoing === 0
    ) {
      status = "No Activity";
    } else if (totals.net > 0) {
      status = "Profit";
    } else if (totals.net < 0) {
      status = "Loss";
    } else {
      status = "Break Even";
    }

    return res.json({
      success: true,

      year,

      months,

      totals: {
        ...totals,
        status,
      },

      chart: {
        labels: months.map(
          (month) => month.month_name
        ),

        income: months.map(
          (month) => month.income
        ),

        expenses: months.map(
          (month) => month.expenses
        ),

        loan_repayment: months.map(
          (month) =>
            month.loan_emi +
            month.loan_repayment
        ),

        borrow_repayment: months.map(
          (month) =>
            month.borrow_repayment
        ),

        net: months.map(
          (month) => month.net
        ),
      },
    });
  } catch (error) {
    console.error("❌ Monthly performance error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to calculate monthly performance",
      error: error.message,
    });
  }
});

// ============================================================
// 3. SELECTED MONTH COMPLETE PERFORMANCE
// GET /api/performance?month=2026-08
//
// Combines weekly + monthly selected-month data in one response.
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

    const weeks = [1, 2, 3, 4, 5].map(emptyWeek);

    // ========================================================
    // All weekly data in one database query per source.
    // ========================================================

    const [expenseResult, repaymentResult, paymentResult] =
      await Promise.all([
        db.query(
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
        ),

        db.query(
          `
          SELECT
            CASE
              WHEN EXTRACT(DAY FROM payment_date) BETWEEN 1 AND 7 THEN 1
              WHEN EXTRACT(DAY FROM payment_date) BETWEEN 8 AND 14 THEN 2
              WHEN EXTRACT(DAY FROM payment_date) BETWEEN 15 AND 21 THEN 3
              WHEN EXTRACT(DAY FROM payment_date) BETWEEN 22 AND 28 THEN 4
              ELSE 5
            END AS week,

            COALESCE(
              SUM(amount) FILTER (
                WHERE payment_type = 'EMI'
              ),
              0
            ) AS loan_emi,

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

          GROUP BY week
          ORDER BY week
          `,
          [
            req.userId,
            range.monthStart,
            range.nextMonthStart,
          ]
        ),

        db.query(
          `
          SELECT
            CASE
              WHEN EXTRACT(DAY FROM payment_date) BETWEEN 1 AND 7 THEN 1
              WHEN EXTRACT(DAY FROM payment_date) BETWEEN 8 AND 14 THEN 2
              WHEN EXTRACT(DAY FROM payment_date) BETWEEN 15 AND 21 THEN 3
              WHEN EXTRACT(DAY FROM payment_date) BETWEEN 22 AND 28 THEN 4
              ELSE 5
            END AS week,

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
            ) AS lost

          FROM personal_payments

          WHERE user_id = $1
            AND payment_date >= $2::DATE
            AND payment_date < $3::DATE

          GROUP BY week
          ORDER BY week
          `,
          [
            req.userId,
            range.monthStart,
            range.nextMonthStart,
          ]
        ),
      ]);

    expenseResult.rows.forEach((row) => {
      const week = Number(row.week);
      weeks[week - 1].expenses = toNumber(row.total);
    });

    repaymentResult.rows.forEach((row) => {
      const week = Number(row.week);

      weeks[week - 1].loan_emi =
        toNumber(row.loan_emi);

      weeks[week - 1].loan_repayment =
        toNumber(row.loan_repayment);

      weeks[week - 1].borrow_repayment =
        toNumber(row.borrow_repayment);

      weeks[week - 1].total_repayment =
        weeks[week - 1].loan_emi +
        weeks[week - 1].loan_repayment +
        weeks[week - 1].borrow_repayment;
    });

    paymentResult.rows.forEach((row) => {
      const week = Number(row.week);

      weeks[week - 1].received_payment =
        toNumber(row.received);

      weeks[week - 1].pending_payment =
        toNumber(row.pending);

      weeks[week - 1].overdue_payment =
        toNumber(row.overdue);

      weeks[week - 1].lost_payment =
        toNumber(row.lost);
    });

    weeks.forEach((week) => {
      week.total_income =
        week.received_payment;

      week.total_outgoing =
        week.expenses +
        week.total_repayment;

      week.net =
        week.total_income -
        week.total_outgoing;

      if (
        week.total_income === 0 &&
        week.total_outgoing === 0
      ) {
        week.status = "No Activity";
      } else if (week.net > 0) {
        week.status = "Profit";
      } else if (week.net < 0) {
        week.status = "Loss";
      } else {
        week.status = "Break Even";
      }
    });

    const totals = weeks.reduce(
      (acc, week) => {
        Object.keys(acc).forEach((key) => {
          if (key !== "status") {
            acc[key] += Number(week[key] || 0);
          }
        });

        return acc;
      },
      {
        expenses: 0,
        loan_emi: 0,
        loan_repayment: 0,
        borrow_repayment: 0,
        total_repayment: 0,
        received_payment: 0,
        pending_payment: 0,
        overdue_payment: 0,
        lost_payment: 0,
        total_income: 0,
        total_outgoing: 0,
        net: 0,
      }
    );

    let status = "No Activity";

    if (
      totals.total_income === 0 &&
      totals.total_outgoing === 0
    ) {
      status = "No Activity";
    } else if (totals.net > 0) {
      status = "Profit";
    } else if (totals.net < 0) {
      status = "Loss";
    } else {
      status = "Break Even";
    }

    return res.json({
      success: true,

      month,

      weekly: weeks,

      totals: {
        ...totals,
        status,
      },

      chart: {
        income: totals.total_income,
        expenses: totals.expenses,
        loan_emi: totals.loan_emi,
        loan_repayment: totals.loan_repayment,
        borrow_repayment: totals.borrow_repayment,
        pending: totals.pending_payment,
        overdue: totals.overdue_payment,
        lost: totals.lost_payment,
        net: totals.net,
      },
    });
  } catch (error) {
    console.error("❌ Complete performance error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to calculate performance",
      error: error.message,
    });
  }
});

// ============================================================
// 4. PERFORMANCE PIE CHART DATA
// GET /api/performance/pie?month=2026-08
//
// Professional chart data:
// Income
// Expenses
// Loan/EMI
// Borrow repayment
// Pending/Lost
// ============================================================

router.get("/pie", authenticate, async (req, res) => {
  try {
    const month = req.query.month || getCurrentMonth();
    const range = getMonthRange(month);

    if (!range) {
      return res.status(400).json({
        success: false,
        message: "Invalid month. Use YYYY-MM.",
      });
    }

    const [expense, payment, repayment] =
      await Promise.all([
        db.query(
          `
          SELECT COALESCE(SUM(amount),0) AS total
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

        db.query(
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
            ) AS lost
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

        db.query(
          `
          SELECT
            COALESCE(
              SUM(amount) FILTER (
                WHERE payment_type = 'EMI'
              ),
              0
            ) AS loan_emi,

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
          [
            req.userId,
            range.monthStart,
            range.nextMonthStart,
          ]
        ),
      ]);

    const expenseTotal =
      toNumber(expense.rows[0].total);

    const received =
      toNumber(payment.rows[0].received);

    const pending =
      toNumber(payment.rows[0].pending);

    const overdue =
      toNumber(payment.rows[0].overdue);

    const lost =
      toNumber(payment.rows[0].lost);

    const loanEmi =
      toNumber(repayment.rows[0].loan_emi);

    const loanRepayment =
      toNumber(repayment.rows[0].loan_repayment);

    const borrowRepayment =
      toNumber(repayment.rows[0].borrow_repayment);

    return res.json({
      success: true,
      month,

      data: [
        {
          label: "Received Income",
          value: received,
        },
        {
          label: "Expenses",
          value: expenseTotal,
        },
        {
          label: "Loan / EMI",
          value: loanEmi + loanRepayment,
        },
        {
          label: "Borrow Repayment",
          value: borrowRepayment,
        },
        {
          label: "Pending",
          value: pending,
        },
        {
          label: "Overdue",
          value: overdue,
        },
        {
          label: "Lost",
          value: lost,
        },
      ],
    });
  } catch (error) {
    console.error("❌ Performance pie error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to calculate performance chart data",
      error: error.message,
    });
  }
});

// ============================================================
// EXPORT
// ============================================================

module.exports = router;