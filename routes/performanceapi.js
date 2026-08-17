// routes/performanceApi.js
// Performance API
// Weekly + selected-month financial performance + yearly monthly performance + pie chart
// Uses:
//   personal_expenses
//   personal_loan_emi_payments
//   personal_payments
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

    const token = header.substring(7).trim();
    const decoded = jwt.verify(token, JWT_SECRET);

    const userId = Number(
      decoded?.id ??
      decoded?.userId ??
      decoded?.sub
    );

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
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || "")) {
    return null;
  }

  const [year, monthNumber] = month.split("-").map(Number);

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
  const number = Number(value || 0);

  return Number.isFinite(number) ? number : 0;
};

const monthName = (month) => {
  const [year, monthNumber] = month.split("-").map(Number);

  return new Date(
    Date.UTC(year, monthNumber - 1, 1)
  ).toLocaleString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
};

const createWeeks = () => [
  {
    week: 1,
    label: "Week 1",
    date_range: "1-7",
    expenses: 0,
    loan_emi: 0,
    loan_repayment: 0,
    borrow_repayment: 0,
    total_loans: 0,
    received_payment: 0,
    pending_payment: 0,
    overdue_payment: 0,
    lost_payment: 0,
    total_income: 0,
    total_outgoing: 0,
    net: 0,
    status: "No Activity",
  },
  {
    week: 2,
    label: "Week 2",
    date_range: "8-14",
    expenses: 0,
    loan_emi: 0,
    loan_repayment: 0,
    borrow_repayment: 0,
    total_loans: 0,
    received_payment: 0,
    pending_payment: 0,
    overdue_payment: 0,
    lost_payment: 0,
    total_income: 0,
    total_outgoing: 0,
    net: 0,
    status: "No Activity",
  },
  {
    week: 3,
    label: "Week 3",
    date_range: "15-21",
    expenses: 0,
    loan_emi: 0,
    loan_repayment: 0,
    borrow_repayment: 0,
    total_loans: 0,
    received_payment: 0,
    pending_payment: 0,
    overdue_payment: 0,
    lost_payment: 0,
    total_income: 0,
    total_outgoing: 0,
    net: 0,
    status: "No Activity",
  },
  {
    week: 4,
    label: "Week 4",
    date_range: "22-28",
    expenses: 0,
    loan_emi: 0,
    loan_repayment: 0,
    borrow_repayment: 0,
    total_loans: 0,
    received_payment: 0,
    pending_payment: 0,
    overdue_payment: 0,
    lost_payment: 0,
    total_income: 0,
    total_outgoing: 0,
    net: 0,
    status: "No Activity",
  },
  {
    week: 5,
    label: "Week 5",
    date_range: "29-end",
    expenses: 0,
    loan_emi: 0,
    loan_repayment: 0,
    borrow_repayment: 0,
    total_loans: 0,
    received_payment: 0,
    pending_payment: 0,
    overdue_payment: 0,
    lost_payment: 0,
    total_income: 0,
    total_outgoing: 0,
    net: 0,
    status: "No Activity",
  },
];

const calculateWeek = (week) => {
  week.total_loans =
    week.loan_emi +
    week.loan_repayment;

  week.total_income = week.received_payment;

  week.total_outgoing =
    week.expenses +
    week.total_loans +
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

  return week;
};

const calculateTotals = (weeks) => {
  const totals = {
    expenses: 0,
    loan_emi: 0,
    loan_repayment: 0,
    borrow_repayment: 0,
    total_loans: 0,
    received_payment: 0,
    pending_payment: 0,
    overdue_payment: 0,
    lost_payment: 0,
    total_income: 0,
    total_outgoing: 0,
    net: 0,
  };

  weeks.forEach((week) => {
    Object.keys(totals).forEach((key) => {
      totals[key] += toNumber(week[key]);
    });
  });

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

  return {
    ...totals,
    status,
  };
};

// ============================================================
// COMMON SELECTED-MONTH DATA
// ============================================================

const getSelectedMonthData = async (userId, month) => {
  const range = getMonthRange(month);

  if (!range) {
    const error = new Error("Invalid month. Use YYYY-MM.");
    error.statusCode = 400;
    throw error;
  }

  const weeks = createWeeks();

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
        [userId, range.monthStart, range.nextMonthStart]
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
        [userId, range.monthStart, range.nextMonthStart]
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
        [userId, range.monthStart, range.nextMonthStart]
      ),
    ]);

  expenseResult.rows.forEach((row) => {
    const week = Number(row.week);

    if (weeks[week - 1]) {
      weeks[week - 1].expenses = toNumber(row.total);
    }
  });

  repaymentResult.rows.forEach((row) => {
    const week = Number(row.week);

    if (weeks[week - 1]) {
      weeks[week - 1].loan_emi = toNumber(row.loan_emi);
      weeks[week - 1].loan_repayment =
        toNumber(row.loan_repayment);
      weeks[week - 1].borrow_repayment =
        toNumber(row.borrow_repayment);
    }
  });

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

  weeks.forEach(calculateWeek);

  const totals = calculateTotals(weeks);

  return {
    month,
    month_name: monthName(month),
    month_start: range.monthStart,
    month_end: range.nextMonthStart,
    weekly: weeks,
    totals,
  };
};

// ============================================================
// 1. SELECTED MONTH COMPLETE PERFORMANCE
// GET /api/performance?month=2026-08
//
// Main endpoint for Performance.jsx.
// Gives all selected-month details + weekly breakdown.
// ============================================================

router.get("/", authenticate, async (req, res) => {
  try {
    const month = String(
      req.query.month || getCurrentMonth()
    );

    const data = await getSelectedMonthData(
      req.userId,
      month
    );

    return res.json({
      success: true,

      title: "Performance",

      description:
        `Weekly financial performance and selected-month activity for ${data.month_name}.`,

      month: data.month,
      month_name: data.month_name,

      weekly: data.weekly,

      totals: data.totals,

      monthlyPerformance: {
        title: "Monthly Performance",
        description:
          `Combined weekly activity for ${data.month_name}.`,
        weeks: data.weekly,
        totals: data.totals,
      },

      cards: {
        expenses: data.totals.expenses,
        loans: data.totals.total_loans,
        borrow: data.totals.borrow_repayment,
        received: data.totals.received_payment,
        pending: data.totals.pending_payment,
      },

      pie: [
        {
          label: "Expenses",
          value: data.totals.expenses,
        },
        {
          label: "Loans",
          value: data.totals.total_loans,
        },
        {
          label: "Borrow",
          value: data.totals.borrow_repayment,
        },
        {
          label: "Received",
          value: data.totals.received_payment,
        },
        {
          label: "Pending",
          value: data.totals.pending_payment,
        },
      ],
    });
  } catch (error) {
    console.error("❌ Selected month performance error:", error);

    return res.status(error.statusCode || 500).json({
      success: false,
      message:
        error.statusCode === 400
          ? error.message
          : "Failed to calculate performance",
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : undefined,
    });
  }
});

// ============================================================
// 2. WEEKLY PERFORMANCE
// GET /api/performance/weekly?month=2026-08
// ============================================================

router.get("/weekly", authenticate, async (req, res) => {
  try {
    const month = String(
      req.query.month || getCurrentMonth()
    );

    const data = await getSelectedMonthData(
      req.userId,
      month
    );

    return res.json({
      success: true,
      month: data.month,
      month_name: data.month_name,

      title: "Weekly Performance",

      weekly: data.weekly,

      totals: data.totals,
    });
  } catch (error) {
    console.error("❌ Weekly performance error:", error);

    return res.status(error.statusCode || 500).json({
      success: false,
      message:
        error.statusCode === 400
          ? error.message
          : "Failed to calculate weekly performance",
    });
  }
});

// ============================================================
// 3. MONTHLY PERFORMANCE
// GET /api/performance/monthly?year=2026
//
// Gives January-December performance for selected year.
// ============================================================

router.get("/monthly", authenticate, async (req, res) => {
  try {
    const year = Number(
      req.query.year || new Date().getFullYear()
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
      (_, index) => ({
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
        loans: 0,
        total_outgoing: 0,
        net: 0,
        status: "No Activity",
      })
    );

    const [
      paymentResult,
      expenseResult,
      repaymentResult,
    ] = await Promise.all([
      db.query(
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
      ),

      db.query(
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
      ),

      db.query(
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
      ),
    ]);

    paymentResult.rows.forEach((row) => {
      const index = Number(row.month) - 1;

      if (months[index]) {
        months[index].income =
          toNumber(row.income);
      }
    });

    expenseResult.rows.forEach((row) => {
      const index = Number(row.month) - 1;

      if (months[index]) {
        months[index].expenses =
          toNumber(row.expenses);
      }
    });

    repaymentResult.rows.forEach((row) => {
      const index = Number(row.month) - 1;

      if (months[index]) {
        months[index].loan_emi =
          toNumber(row.loan_emi);

        months[index].loan_repayment =
          toNumber(row.loan_repayment);

        months[index].borrow_repayment =
          toNumber(row.borrow_repayment);
      }
    });

    months.forEach((month) => {
      month.loans =
        month.loan_emi +
        month.loan_repayment;

      month.total_outgoing =
        month.expenses +
        month.loans +
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
        acc.borrow_repayment +=
          month.borrow_repayment;
        acc.loans += month.loans;
        acc.total_outgoing +=
          month.total_outgoing;
        acc.net += month.net;

        return acc;
      },
      {
        income: 0,
        expenses: 0,
        loan_emi: 0,
        loan_repayment: 0,
        borrow_repayment: 0,
        loans: 0,
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

      title: "Monthly Performance",

      description:
        `Monthly financial performance for ${year}.`,

      months,

      totals: {
        ...totals,
        status,
      },

      chart: {
        labels: months.map(
          (item) => item.month_name
        ),
        income: months.map(
          (item) => item.income
        ),
        expenses: months.map(
          (item) => item.expenses
        ),
        loans: months.map(
          (item) => item.loans
        ),
        borrow: months.map(
          (item) => item.borrow_repayment
        ),
        net: months.map(
          (item) => item.net
        ),
      },
    });
  } catch (error) {
    console.error("❌ Monthly performance error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to calculate monthly performance",
    });
  }
});

// ============================================================
// 4. PIE CHART
// GET /api/performance/pie?month=2026-08
//
// Exactly the five requested sections:
// Expenses
// Loans
// Borrow
// Received
// Pending
// ============================================================

router.get("/pie", authenticate, async (req, res) => {
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

    const [
      expenseResult,
      repaymentResult,
      paymentResult,
    ] = await Promise.all([
      db.query(
        `
        SELECT COALESCE(SUM(amount), 0) AS total
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
            SUM(amount) FILTER (
              WHERE payment_type IN (
                'EMI',
                'Loan Repayment'
              )
            ),
            0
          ) AS loans,

          COALESCE(
            SUM(amount) FILTER (
              WHERE payment_type = 'Borrow Repayment'
            ),
            0
          ) AS borrow

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
          ) AS pending

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
    ]);

    const values = {
      expenses: toNumber(
        expenseResult.rows[0]?.total
      ),
      loans: toNumber(
        repaymentResult.rows[0]?.loans
      ),
      borrow: toNumber(
        repaymentResult.rows[0]?.borrow
      ),
      received: toNumber(
        paymentResult.rows[0]?.received
      ),
      pending: toNumber(
        paymentResult.rows[0]?.pending
      ),
    };

    const total =
      values.expenses +
      values.loans +
      values.borrow +
      values.received +
      values.pending;

    const pie = [
      {
        label: "Expenses",
        value: values.expenses,
      },
      {
        label: "Loans",
        value: values.loans,
      },
      {
        label: "Borrow",
        value: values.borrow,
      },
      {
        label: "Received",
        value: values.received,
      },
      {
        label: "Pending",
        value: values.pending,
      },
    ].map((item) => ({
      ...item,
      percentage:
        total > 0
          ? Number(
              ((item.value / total) * 100).toFixed(2)
            )
          : 0,
    }));

    return res.json({
      success: true,

      month,
      month_name: monthName(month),

      values,

      total,

      pie,
    });
  } catch (error) {
    console.error("❌ Performance pie error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to calculate performance pie chart",
    });
  }
});

// ============================================================
// 5. SELECTED MONTH SUMMARY CARDS
// GET /api/performance/cards?month=2026-08
// ============================================================

router.get("/cards", authenticate, async (req, res) => {
  try {
    const month = String(
      req.query.month || getCurrentMonth()
    );

    const data = await getSelectedMonthData(
      req.userId,
      month
    );

    const cards = [
      {
        key: "expenses",
        label: "Expenses",
        amount: data.totals.expenses,
      },
      {
        key: "loans",
        label: "Loans",
        amount: data.totals.total_loans,
      },
      {
        key: "borrow",
        label: "Borrow",
        amount: data.totals.borrow_repayment,
      },
      {
        key: "received",
        label: "Received",
        amount: data.totals.received_payment,
      },
      {
        key: "pending",
        label: "Pending",
        amount: data.totals.pending_payment,
      },
    ];

    return res.json({
      success: true,
      month: data.month,
      month_name: data.month_name,
      cards,
    });
  } catch (error) {
    console.error("❌ Performance cards error:", error);

    return res.status(error.statusCode || 500).json({
      success: false,
      message:
        error.statusCode === 400
          ? error.message
          : "Failed to calculate performance cards",
    });
  }
});

module.exports = router;