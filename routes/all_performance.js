const express = require("express");
const jwt = require("jsonwebtoken");
const router = express.Router();
const db = require("../db.js");

/*
  all_performance.js
  OLD TABLE SCHEMA VERSION

  Mount:
    app.use("/api/performance", performanceRoutes);

  Main:
    GET /api/performance?month=1%20Aug%202026

  Widgets:
    GET /api/performance/widgets?month=1%20Aug%202026

  This version intentionally uses the OLD schema:
    personal_borrow
    personal_borrow_repayments
    personal_loans
    personal_loan_emi_payments
    payment_type
    loan_id
    borrow_amount
    total_loan_amount
    total_emis
    bank_name
    category icon/color
*/

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.split(" ")[1]
    : null;

  if (!token) {
    return res.status(401).json({
      error: "Access denied. No token provided.",
    });
  }

  jwt.verify(
    token,
    process.env.JWT_SECRET || "your_secret_key",
    (err, user) => {
      if (err) {
        return res.status(403).json({
          error: "Invalid or expired token.",
        });
      }

      req.user = user;
      next();
    }
  );
};

const toNumber = (value) => Number(value) || 0;

const parseMonthStart = (monthValue) => {
  if (!monthValue) {
    const now = new Date();
    return new Date(
      now.getFullYear(),
      now.getMonth(),
      1
    );
  }

  const parsed = new Date(monthValue);

  if (Number.isNaN(parsed.getTime())) {
    throw new Error(
      "Invalid month. Use format like '1 Aug 2026'."
    );
  }

  return new Date(
    parsed.getFullYear(),
    parsed.getMonth(),
    1
  );
};

const sqlDate = (date) =>
  `${date.getFullYear()}-${String(
    date.getMonth() + 1
  ).padStart(2, "0")}-01`;

const displayMonth = (date) =>
  date.toLocaleDateString("en-IN", {
    month: "long",
    year: "numeric",
  });

const formatDate = (value) => {
  if (!value) return null;

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString().slice(0, 10);
};

const savingStatus = (value) => {
  if (value > 0) {
    return {
      status: "profit",
      message: `🎉 Profit: ₹${value.toFixed(2)}`,
      color: "#10B981",
    };
  }

  if (value < 0) {
    return {
      status: "loss",
      message: `⚠️ Loss: ₹${Math.abs(value).toFixed(2)}`,
      color: "#EF4444",
    };
  }

  return {
    status: "break_even",
    message: "⚖️ Break Even",
    color: "#F59E0B",
  };
};

const emptyStatusBreakdown = () => ({
  received: { count: 0, amount: 0 },
  pending: { count: 0, amount: 0 },
  overdue: { count: 0, amount: 0 },
  lost: { count: 0, amount: 0 },
});

// ============================================================
// MAIN PERFORMANCE
// ============================================================
router.get("/", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    let monthStart;

    try {
      monthStart = parseMonthStart(req.query.month);
    } catch (error) {
      return res.status(400).json({
        error: error.message,
      });
    }

    const monthDate = sqlDate(monthStart);

    // --------------------------------------------------------
    // 1. TOTAL INCOME
    // --------------------------------------------------------
    const incomeResult = await db.query(
      `
      SELECT
        COALESCE(work_payment, 0) AS work_payment,
        COALESCE(business_payment, 0) AS business_payment,
        COALESCE(total_work, 0) AS total_work,
        COALESCE(total_business, 0) AS total_business
      FROM personal_overview
      WHERE user_id = $1
        AND month_start = $2::date
      LIMIT 1
      `,
      [userId, monthDate]
    );

    const overview = incomeResult.rows[0] || {};

    const workPayment = toNumber(
      overview.work_payment
    );
    const businessPayment = toNumber(
      overview.business_payment
    );

    const totalWork = Number(
      overview.total_work || 0
    );
    const totalBusiness = Number(
      overview.total_business || 0
    );

    const totalIncome =
      workPayment + businessPayment;

    // --------------------------------------------------------
    // 2. TOTAL EXPENSES
    // --------------------------------------------------------
    const expenseResult = await db.query(
      `
      SELECT
        COALESCE(SUM(amount), 0) AS total_expenses,
        COUNT(*) AS expense_count
      FROM personal_expenses
      WHERE user_id = $1
        AND DATE_TRUNC('month', expense_date)
            = $2::date
      `,
      [userId, monthDate]
    );

    const totalExpenses = toNumber(
      expenseResult.rows[0]?.total_expenses
    );

    const expenseCount = Number(
      expenseResult.rows[0]?.expense_count || 0
    );

    // --------------------------------------------------------
    // 3. EXPENSE CATEGORY BREAKDOWN
    // Old table has icon + color.
    // --------------------------------------------------------
    const categoryResult = await db.query(
      `
      SELECT
        c.id AS category_id,
        c.category_name,
        c.icon,
        c.color,
        COALESCE(SUM(e.amount), 0) AS total_amount,
        COUNT(e.id) AS expense_count
      FROM personal_expense_categories c
      LEFT JOIN personal_expenses e
        ON e.category_id = c.id
       AND e.user_id = $1
       AND DATE_TRUNC('month', e.expense_date)
           = $2::date
      WHERE c.user_id = $1
      GROUP BY
        c.id,
        c.category_name,
        c.icon,
        c.color
      ORDER BY total_amount DESC
      `,
      [userId, monthDate]
    );

    const categories =
      categoryResult.rows.map((row) => {
        const amount = toNumber(
          row.total_amount
        );

        return {
          category_id: row.category_id,
          category_name:
            row.category_name,
          icon: row.icon || "📊",
          color:
            row.color || "#3B82F6",
          total_amount: amount,
          expense_count: Number(
            row.expense_count || 0
          ),
          percentage:
            totalExpenses > 0
              ? (amount / totalExpenses) *
                100
              : 0,
        };
      });

    // --------------------------------------------------------
    // 4. WEEKLY EXPENSES
    // 1-7 / 8-14 / 15-21 / 22-end
    // --------------------------------------------------------
    const weeklyResult = await db.query(
      `
      SELECT
        CASE
          WHEN EXTRACT(DAY FROM expense_date)
               BETWEEN 1 AND 7 THEN 1
          WHEN EXTRACT(DAY FROM expense_date)
               BETWEEN 8 AND 14 THEN 2
          WHEN EXTRACT(DAY FROM expense_date)
               BETWEEN 15 AND 21 THEN 3
          ELSE 4
        END AS week_number,
        COALESCE(SUM(amount), 0) AS total_amount,
        COUNT(*) AS expense_count
      FROM personal_expenses
      WHERE user_id = $1
        AND DATE_TRUNC('month', expense_date)
            = $2::date
      GROUP BY week_number
      ORDER BY week_number
      `,
      [userId, monthDate]
    );

    const weeks = new Map(
      weeklyResult.rows.map((row) => [
        Number(row.week_number),
        row,
      ])
    );

    const weekly = [
      [1, "1-7"],
      [2, "8-14"],
      [3, "15-21"],
      [4, "22-end"],
    ].map(([weekNumber, label]) => {
      const row = weeks.get(weekNumber);
      const amount = toNumber(
        row?.total_amount
      );

      return {
        week_number: weekNumber,
        week_label: `Week ${label}`,
        total_amount: amount,
        expense_count: Number(
          row?.expense_count || 0
        ),
        percentage:
          totalExpenses > 0
            ? (amount / totalExpenses) *
              100
            : 0,
      };
    });

    // --------------------------------------------------------
    // 5. TOTAL BORROW
    // OLD TABLE: personal_borrow
    // --------------------------------------------------------
    const borrowTotalResult = await db.query(
      `
      SELECT
        COALESCE(SUM(borrow_amount), 0)
          AS total_borrow,
        COUNT(*) AS borrow_count
      FROM personal_borrow
      WHERE user_id = $1
        AND DATE_TRUNC('month', take_date)
            = $2::date
      `,
      [userId, monthDate]
    );

    const totalBorrow = toNumber(
      borrowTotalResult.rows[0]?.total_borrow
    );

    const borrowCount = Number(
      borrowTotalResult.rows[0]?.borrow_count || 0
    );

    // --------------------------------------------------------
    // 6. TOTAL LOAN
    // OLD TABLE: personal_loans
    // --------------------------------------------------------
    const loanTotalResult = await db.query(
      `
      SELECT
        COALESCE(SUM(total_loan_amount), 0)
          AS total_loan,
        COUNT(*) AS loan_count
      FROM personal_loans
      WHERE user_id = $1
        AND DATE_TRUNC('month', created_at)
            = $2::date
      `,
      [userId, monthDate]
    );

    const totalLoan = toNumber(
      loanTotalResult.rows[0]?.total_loan
    );

    const loanCount = Number(
      loanTotalResult.rows[0]?.loan_count || 0
    );

    // --------------------------------------------------------
    // 7. TOTAL EMI PAID
    // OLD TABLE: emi_amount
    // Uses payment_type = EMI.
    // --------------------------------------------------------
    const emiTotalResult = await db.query(
      `
      SELECT
        COALESCE(
          SUM(
            CASE
              WHEN LOWER(payment_type) = 'emi'
              THEN emi_amount
              ELSE 0
            END
          ),
          0
        ) AS total_emi_paid,

        COUNT(
          CASE
            WHEN LOWER(payment_type) = 'emi'
            THEN 1
          END
        ) AS emi_count
      FROM personal_loan_emi_payments
      WHERE user_id = $1
        AND DATE_TRUNC('month', payment_date)
            = $2::date
      `,
      [userId, monthDate]
    );

    const totalEmiPaid = toNumber(
      emiTotalResult.rows[0]?.total_emi_paid
    );

    const emiCount = Number(
      emiTotalResult.rows[0]?.emi_count || 0
    );

    // --------------------------------------------------------
    // 8. ACTIVE LOANS
    // Remaining EMIs = total_emis - paid EMI count
    // --------------------------------------------------------
    const activeLoanResult = await db.query(
      `
      SELECT
        l.id,
        l.bank_name,
        l.total_loan_amount,
        l.emi_amount,
        l.total_emis,
        l.next_emi_date,
        l.status,

        COUNT(
          CASE
            WHEN LOWER(e.payment_type) = 'emi'
            THEN 1
          END
        ) AS paid_emis,

        GREATEST(
          l.total_emis -
          COUNT(
            CASE
              WHEN LOWER(e.payment_type) = 'emi'
              THEN 1
            END
          ),
          0
        ) AS remaining_emis,

        COALESCE(
          SUM(
            CASE
              WHEN LOWER(e.payment_type) = 'emi'
              THEN e.emi_amount
              ELSE 0
            END
          ),
          0
        ) AS total_paid,

        (
          l.next_emi_date -
          CURRENT_DATE
        ) AS days_until_next_emi

      FROM personal_loans l

      LEFT JOIN personal_loan_emi_payments e
        ON e.loan_id = l.id
       AND e.user_id = l.user_id

      WHERE l.user_id = $1
        AND LOWER(l.status) = 'active'

      GROUP BY
        l.id,
        l.bank_name,
        l.total_loan_amount,
        l.emi_amount,
        l.total_emis,
        l.next_emi_date,
        l.status

      ORDER BY l.next_emi_date ASC
      `,
      [userId]
    );

    const activeLoans =
      activeLoanResult.rows.map(
        (row) => ({
          id: row.id,
          bank_name:
            row.bank_name,
          total_loan_amount:
            toNumber(
              row.total_loan_amount
            ),
          emi_amount:
            toNumber(row.emi_amount),
          total_emis:
            Number(row.total_emis || 0),
          paid_emis:
            Number(row.paid_emis || 0),
          remaining_emis:
            Number(
              row.remaining_emis || 0
            ),
          next_emi_date:
            formatDate(
              row.next_emi_date
            ),
          days_until_next_emi:
            Number(
              row.days_until_next_emi || 0
            ),
          status: row.status,
          total_paid:
            toNumber(row.total_paid),
        })
      );

    const totalRemainingEmis =
      activeLoans.reduce(
        (sum, loan) =>
          sum + loan.remaining_emis,
        0
      );

    const totalRemainingLoan =
      activeLoans.reduce(
        (sum, loan) =>
          sum +
          loan.remaining_emis *
            loan.emi_amount,
        0
      );

    // --------------------------------------------------------
    // 9. ACTIVE BORROWS
    // remaining = borrow_amount - repayment_amount
    // --------------------------------------------------------
    const activeBorrowResult = await db.query(
      `
      SELECT
        b.id,
        b.person_name,
        b.borrow_amount,
        b.take_date,
        b.return_date,
        b.status,

        COALESCE(
          SUM(
            CASE
              WHEN LOWER(r.status) = 'paid'
              THEN r.repayment_amount
              ELSE 0
            END
          ),
          0
        ) AS total_repaid,

        GREATEST(
          b.borrow_amount -
          COALESCE(
            SUM(
              CASE
                WHEN LOWER(r.status) = 'paid'
                THEN r.repayment_amount
                ELSE 0
              END
            ),
            0
          ),
          0
        ) AS remaining_amount,

        (
          b.return_date -
          CURRENT_DATE
        ) AS days_remaining

      FROM personal_borrow b

      LEFT JOIN personal_borrow_repayments r
        ON r.borrow_id = b.id
       AND r.user_id = b.user_id

      WHERE b.user_id = $1
        AND LOWER(b.status) = 'active'

      GROUP BY
        b.id,
        b.person_name,
        b.borrow_amount,
        b.take_date,
        b.return_date,
        b.status

      ORDER BY b.return_date ASC
      `,
      [userId]
    );

    const activeBorrows =
      activeBorrowResult.rows.map(
        (row) => ({
          id: row.id,
          person_name:
            row.person_name,
          borrow_amount:
            toNumber(
              row.borrow_amount
            ),
          total_repaid:
            toNumber(
              row.total_repaid
            ),
          remaining_amount:
            toNumber(
              row.remaining_amount
            ),
          take_date:
            formatDate(row.take_date),
          return_date:
            formatDate(
              row.return_date
            ),
          days_remaining:
            Number(
              row.days_remaining || 0
            ),
          status: row.status,
        })
      );

    const totalRemainingBorrow =
      activeBorrows.reduce(
        (sum, borrow) =>
          sum +
          borrow.remaining_amount,
        0
      );

    // --------------------------------------------------------
    // 10. PAYMENT SUMMARY
    // Old table uses lowercase status.
    // --------------------------------------------------------
    const paymentResult = await db.query(
      `
      SELECT
        COALESCE(
          SUM(
            CASE
              WHEN LOWER(status) = 'received'
              THEN amount
              ELSE 0
            END
          ),
          0
        ) AS total_received,

        COALESCE(
          SUM(
            CASE
              WHEN LOWER(status) = 'pending'
              THEN amount
              ELSE 0
            END
          ),
          0
        ) AS total_pending,

        COALESCE(
          SUM(
            CASE
              WHEN LOWER(status) = 'overdue'
              THEN amount
              ELSE 0
            END
          ),
          0
        ) AS total_overdue,

        COALESCE(
          SUM(
            CASE
              WHEN LOWER(status) = 'lost'
              THEN amount
              ELSE 0
            END
          ),
          0
        ) AS total_lost,

        COALESCE(SUM(amount), 0)
          AS total_payments,

        COUNT(*) AS payment_count

      FROM personal_payments
      WHERE user_id = $1
        AND DATE_TRUNC('month', payment_date)
            = $2::date
      `,
      [userId, monthDate]
    );

    const paymentRow =
      paymentResult.rows[0] || {};

    const paymentTotals = {
      received: toNumber(
        paymentRow.total_received
      ),
      pending: toNumber(
        paymentRow.total_pending
      ),
      overdue: toNumber(
        paymentRow.total_overdue
      ),
      lost: toNumber(
        paymentRow.total_lost
      ),
      total: toNumber(
        paymentRow.total_payments
      ),
    };

    const statusResult = await db.query(
      `
      SELECT
        LOWER(status) AS status,
        COUNT(*) AS count,
        COALESCE(SUM(amount), 0)
          AS total_amount
      FROM personal_payments
      WHERE user_id = $1
        AND DATE_TRUNC('month', payment_date)
            = $2::date
      GROUP BY LOWER(status)
      `,
      [userId, monthDate]
    );

    const paymentBreakdown =
      emptyStatusBreakdown();

    statusResult.rows.forEach((row) => {
      const key = row.status;

      if (paymentBreakdown[key]) {
        paymentBreakdown[key] = {
          count: Number(
            row.count || 0
          ),
          amount: toNumber(
            row.total_amount
          ),
        };
      }
    });

    // --------------------------------------------------------
    // 11. SAVINGS
    // --------------------------------------------------------
    const totalSavings =
      totalIncome -
      totalExpenses -
      totalEmiPaid;

    const savings = savingStatus(
      totalSavings
    );

    const savingsRate =
      totalIncome > 0
        ? (totalSavings /
            totalIncome) *
          100
        : 0;

    // --------------------------------------------------------
    // 12. RECENT TRANSACTIONS
    // --------------------------------------------------------
    const recentResult = await db.query(
      `
      SELECT *
      FROM (
        SELECT
          'expense' AS type,
          e.id,
          e.amount,
          e.expense_date AS transaction_date,
          e.notes AS description,
          c.category_name AS name,
          c.icon,
          c.color
        FROM personal_expenses e
        JOIN personal_expense_categories c
          ON c.id = e.category_id
         AND c.user_id = e.user_id
        WHERE e.user_id = $1
          AND DATE_TRUNC('month', e.expense_date)
              = $2::date

        UNION ALL

        SELECT
          'payment' AS type,
          p.id,
          p.amount,
          p.payment_date AS transaction_date,
          p.notes AS description,
          p.person_name AS name,
          NULL AS icon,
          NULL AS color
        FROM personal_payments p
        WHERE p.user_id = $1
          AND DATE_TRUNC('month', p.payment_date)
              = $2::date
      ) recent
      ORDER BY transaction_date DESC, id DESC
      LIMIT 10
      `,
      [userId, monthDate]
    );

    const recentTransactions =
      recentResult.rows.map(
        (row) => ({
          ...row,
          amount: toNumber(
            row.amount
          ),
          transaction_date:
            formatDate(
              row.transaction_date
            ),
          display_date:
            row.transaction_date
              ? new Date(
                  row.transaction_date
                ).toLocaleDateString(
                  "en-IN",
                  {
                    day: "2-digit",
                    month: "short",
                    year: "numeric",
                  }
                )
              : "—",
        })
      );

    // --------------------------------------------------------
    // 13. ALL-TIME QUICK STATS
    // --------------------------------------------------------
    const quickResult = await db.query(
      `
      SELECT
        (
          SELECT COALESCE(
            SUM(
              work_payment +
              business_payment
            ), 0
          )
          FROM personal_overview
          WHERE user_id = $1
        ) AS all_income,

        (
          SELECT COALESCE(
            SUM(amount), 0
          )
          FROM personal_expenses
          WHERE user_id = $1
        ) AS all_expenses,

        (
          SELECT COALESCE(
            SUM(borrow_amount), 0
          )
          FROM personal_borrow
          WHERE user_id = $1
        ) AS all_borrow,

        (
          SELECT COALESCE(
            SUM(total_loan_amount), 0
          )
          FROM personal_loans
          WHERE user_id = $1
        ) AS all_loan,

        (
          SELECT COALESCE(
            SUM(
              CASE
                WHEN LOWER(payment_type) = 'emi'
                THEN emi_amount
                ELSE 0
              END
            ), 0
          )
          FROM personal_loan_emi_payments
          WHERE user_id = $1
        ) AS all_emi_paid,

        (
          SELECT COALESCE(
            SUM(amount), 0
          )
          FROM personal_payments
          WHERE user_id = $1
            AND LOWER(status) = 'received'
        ) AS all_received
      `,
      [userId]
    );

    const quick =
      quickResult.rows[0] || {};

    const allIncome =
      toNumber(quick.all_income);

    const allExpenses =
      toNumber(quick.all_expenses);

    const allBorrow =
      toNumber(quick.all_borrow);

    const allLoan =
      toNumber(quick.all_loan);

    const allEmiPaid =
      toNumber(quick.all_emi_paid);

    const allReceived =
      toNumber(quick.all_received);

    const allSavings =
      allIncome -
      allExpenses -
      allEmiPaid;

    // --------------------------------------------------------
    // 14. COMPLETE RESPONSE
    // --------------------------------------------------------
    return res.json({
      success: true,

      data: {
        month: {
          start: monthDate,
          display:
            displayMonth(monthStart),
        },

        summary: {
          total_income: totalIncome,

          total_work:
            workPayment,

          total_business:
            businessPayment,

          total_expenses:
            totalExpenses,

          expense_count:
            expenseCount,

          total_borrow:
            totalBorrow,

          borrow_count:
            borrowCount,

          total_loan:
            totalLoan,

          loan_count:
            loanCount,

          total_emi_paid:
            totalEmiPaid,

          emi_count:
            emiCount,

          total_savings:
            totalSavings,

          savings_rate:
            Number(
              savingsRate.toFixed(2)
            ),

          savings_status:
            savings.status,

          savings_status_message:
            savings.message,

          savings_status_color:
            savings.color,
        },

        income_breakdown: {
          work_payment:
            workPayment,

          business_payment:
            businessPayment,

          work_percentage:
            totalIncome > 0
              ? (workPayment /
                  totalIncome) *
                100
              : 0,

          business_percentage:
            totalIncome > 0
              ? (businessPayment /
                  totalIncome) *
                100
              : 0,

          total_work_count:
            totalWork,

          total_business_count:
            totalBusiness,
        },

        expense_breakdown: {
          total:
            totalExpenses,

          count:
            expenseCount,

          categories:
            categories,

          weekly:
            weekly,
        },

        loan_borrow_summary: {
          total_borrow:
            totalBorrow,

          total_loan:
            totalLoan,

          total_emi_paid:
            totalEmiPaid,

          active_loans:
            activeLoans,

          active_borrows:
            activeBorrows,

          total_remaining_emis:
            totalRemainingEmis,

          total_remaining_loan_amount:
            totalRemainingLoan,

          total_remaining_borrow_amount:
            totalRemainingBorrow,

          total_debt_remaining:
            totalRemainingLoan +
            totalRemainingBorrow,
        },

        payment_summary: {
          totals:
            paymentTotals,

          breakdown:
            paymentBreakdown,

          count:
            paymentTotals.total
              ? Number(
                  paymentResult
                    .rows[0]
                    ?.payment_count || 0
                )
              : 0,
        },

        recent_transactions:
          recentTransactions,

        quick_stats: {
          all_time_income:
            allIncome,

          all_time_expenses:
            allExpenses,

          all_time_borrow:
            allBorrow,

          all_time_loan:
            allLoan,

          all_time_emi_paid:
            allEmiPaid,

          all_time_received:
            allReceived,

          all_time_savings:
            allSavings,
        },
      },
    });
  } catch (error) {
    console.error(
      "Error fetching performance data:",
      error
    );

    return res.status(500).json({
      error:
        error.message ||
        "Internal server error",
    });
  }
});

// ============================================================
// WIDGETS
// ============================================================
router.get(
  "/widgets",
  authenticateToken,
  async (req, res) => {
    try {
      const userId = req.user.id;

      let monthStart;

      try {
        monthStart = parseMonthStart(
          req.query.month
        );
      } catch (error) {
        return res.status(400).json({
          error: error.message,
        });
      }

      const monthDate = sqlDate(
        monthStart
      );

      const [
        topExpensesResult,
        upcomingEmisResult,
        overduePaymentsResult,
      ] = await Promise.all([
        db.query(
          `
          SELECT
            c.category_name,
            c.icon,
            c.color,
            COALESCE(
              SUM(e.amount), 0
            ) AS total_amount
          FROM personal_expense_categories c
          JOIN personal_expenses e
            ON e.category_id = c.id
           AND e.user_id = c.user_id
          WHERE c.user_id = $1
            AND DATE_TRUNC(
              'month',
              e.expense_date
            ) = $2::date
          GROUP BY
            c.id,
            c.category_name,
            c.icon,
            c.color
          ORDER BY total_amount DESC
          LIMIT 5
          `,
          [userId, monthDate]
        ),

        db.query(
          `
          SELECT
            id,
            bank_name,
            emi_amount,
            next_emi_date,
            (
              next_emi_date -
              CURRENT_DATE
            ) AS days_until
          FROM personal_loans
          WHERE user_id = $1
            AND LOWER(status) = 'active'
            AND next_emi_date IS NOT NULL
          ORDER BY next_emi_date ASC
          LIMIT 5
          `,
          [userId]
        ),

        db.query(
          `
          SELECT
            id,
            person_name,
            amount,
            payment_date,
            (
              CURRENT_DATE -
              payment_date
            ) AS days_overdue
          FROM personal_payments
          WHERE user_id = $1
            AND LOWER(status) = 'overdue'
          ORDER BY payment_date ASC
          LIMIT 5
          `,
          [userId]
        ),
      ]);

      return res.json({
        success: true,

        data: {
          top_expenses:
            topExpensesResult.rows.map(
              (row) => ({
                category_name:
                  row.category_name,
                icon:
                  row.icon || "📊",
                color:
                  row.color || "#3B82F6",
                total_amount:
                  toNumber(
                    row.total_amount
                  ),
              })
            ),

          upcoming_emis:
            upcomingEmisResult.rows.map(
              (row) => ({
                id: row.id,
                bank_name:
                  row.bank_name,
                emi_amount:
                  toNumber(
                    row.emi_amount
                  ),
                next_emi_date:
                  formatDate(
                    row.next_emi_date
                  ),
                days_until:
                  Number(
                    row.days_until || 0
                  ),
              })
            ),

          overdue_payments:
            overduePaymentsResult.rows.map(
              (row) => ({
                id: row.id,
                person_name:
                  row.person_name,
                amount:
                  toNumber(row.amount),
                payment_date:
                  formatDate(
                    row.payment_date
                  ),
                days_overdue:
                  Number(
                    row.days_overdue || 0
                  ),
              })
            ),
        },
      });
    } catch (error) {
      console.error(
        "Error fetching performance widgets:",
        error
      );

      return res.status(500).json({
        error:
          error.message ||
          "Internal server error",
      });
    }
  }
);

module.exports = router;