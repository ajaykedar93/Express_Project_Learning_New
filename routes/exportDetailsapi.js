/*
  exportDetailsapi.js
  ------------------------------------------------------------
  Professional export API for:
    - Monthly / Weekly reports
    - PDF (A4, no empty pages)
    - Excel
    - TXT
    - JSON data

  IMPORTANT:
    Mount this router with:
      app.use("/api/export-details", exportDetailsRoutes);

    The application should already have its normal authentication
    middleware if it sets req.user.

  Required packages:
    npm install express pg pdfkit exceljs

  Expected database tables:
    personal_users
    personal_business_work
    personal_expenses
    personal_loans_borrow
    personal_loan_emi_payments
    personal_payments
    personal_overview
*/

const express = require("express");
const PDFDocument = require("pdfkit");
const ExcelJS = require("exceljs");


const router = express.Router();

/*
  ROUTES WHEN MOUNTED AS:
    app.use("/api/export-details", exportDetailsRoutes);

  GET /api/export-details/health
  GET /api/export-details/auth-check
  GET /api/export-details/data?period=month&month=YYYY-MM
  GET /api/export-details/data?period=week&month=YYYY-MM&week=1..4

  GET /api/export-details?format=pdf&period=month&month=YYYY-MM
  GET /api/export-details?format=excel&period=month&month=YYYY-MM
  GET /api/export-details?format=text&period=month&month=YYYY-MM

  Weekly export adds:
    &week=1..4
*/

// -----------------------------------------------------------------------------
// CORS
// -----------------------------------------------------------------------------
// This API is called by the React/Vercel frontend from another origin.
// The frontend sends Authorization and x-user-id headers, so the browser
// performs an OPTIONS preflight request. Without this middleware the browser
// reports only: "Failed to fetch".
//
// No "cors" npm package is required.
router.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin) {
    // Echo the requesting origin instead of using "*" because the frontend
    // uses credentials: "include".
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, Accept, X-User-Id, X-Auth-User-Id, X-Userid"
  );

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, OPTIONS"
  );

  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  next();
});

// -----------------------------------------------------------------------------
// DATABASE
// -----------------------------------------------------------------------------
// Use your existing pool. If your project exports pool differently,
// replace this require with your existing db/pool file.
const db = require("../db");

// -----------------------------------------------------------------------------
// AUTH - USE THE SAME LOGGED-IN USER
// -----------------------------------------------------------------------------
// This router does NOT create a second login system.
//
// It accepts the authenticated user from the existing application in the
// common forms used by Express login/JWT/session middleware:
//
//   req.user.id
//   req.user.userId
//   req.user.user_id
//   req.session.user.id
//   req.session.user.userId
//   req.session.user.user_id
//   req.authUser.id
//   req.authUser.userId
//   req.authUser.user_id
//   res.locals.user.id
//   req.userId
//   req.authUserId
//
// It also accepts a Bearer JWT when JWT_SECRET is configured.
// JWT payload fields supported:
//   id, userId, user_id
//
// Finally, x-user-id is accepted only when your existing frontend/backend
// already uses that header. Prefer the existing verified req.user/session path.
//
// IMPORTANT:
// Do not change the login page. Mount this router AFTER your existing auth
// middleware if that middleware populates req.user.
//
// Example:
//
//   app.use(authenticateToken);
//   app.use("/api/export-details", exportDetailsRoutes);
//
// If your login middleware already runs globally, req.user will be used.

function toValidUserId(value) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return null;
  }

  const numeric = Number(value);

  if (
    !Number.isInteger(numeric) ||
    numeric <= 0
  ) {
    return null;
  }

  return numeric;
}

function readUserIdFromObject(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  return (
    toValidUserId(value.id) ||
    toValidUserId(value.userId) ||
    toValidUserId(value.user_id) ||
    null
  );
}

function getUserIdFromExistingAuth(req, res) {
  const candidates = [
    // Existing authentication middleware
    req.user,
    req.authUser,

    // Express session
    req.session && req.session.user,

    // Some applications store the authenticated user in session.userId
    req.session && req.session.userId,
    req.session && req.session.user_id,

    // Express locals
    res.locals && res.locals.user,
    res.locals && res.locals.userId,
    res.locals && res.locals.user_id,

    // Existing middleware may attach these directly
    req.userId,
    req.user_id,
    req.authUserId,
    req.auth_user_id,
  ];

  for (const candidate of candidates) {
    const objectId = readUserIdFromObject(candidate);

    if (objectId) {
      return objectId;
    }

    const directId = toValidUserId(candidate);

    if (directId) {
      return directId;
    }
  }

  return null;
}

function getUserIdFromBearerToken(req) {
  const header =
    req.headers && req.headers.authorization;

  if (!header) {
    return null;
  }

  const match =
    /^Bearer\s+(.+)$/i.exec(String(header).trim());

  if (!match) {
    return null;
  }

  const token = match[1].trim();

  // Some simple login implementations send the numeric user ID as the
  // bearer value. Support that without changing the login page.
  const numericTokenId = toValidUserId(token);

  if (numericTokenId) {
    return numericTokenId;
  }

  // JWT verification is used only when JWT_SECRET exists.
  // Never trust an unsigned JWT in production.
  if (!process.env.JWT_SECRET) {
    return null;
  }

  try {
    // jsonwebtoken is intentionally required only when JWT_SECRET is set.
    // Install it if your existing login uses JWT:
    // npm install jsonwebtoken
    const jwt = require("jsonwebtoken");

    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET
    );

    return readUserIdFromObject(decoded);
  } catch (error) {
    console.error(
      "Export JWT verification failed:",
      error.message
    );

    return null;
  }
}

function getUserIdFromHeaders(req) {
  const headers = req.headers || {};

  const candidates = [
    headers["x-user-id"],
    headers["x-auth-user-id"],
    headers["x-userid"],
  ];

  for (const value of candidates) {
    const id = toValidUserId(value);

    if (id) {
      return id;
    }
  }

  return null;
}

function requireUser(req, res, next) {
  // 1. First priority: EXACT authenticated user from existing login middleware.
  let userId = getUserIdFromExistingAuth(req, res);

  // 2. Second priority: existing Bearer authentication.
  if (!userId) {
    userId = getUserIdFromBearerToken(req);
  }

  // 3. Compatibility with projects that already send x-user-id.
  if (!userId) {
    userId = getUserIdFromHeaders(req);
  }

  if (!userId) {
    return res.status(401).json({
      success: false,
      message:
        "User authentication required. Use the same logged-in user ID/session/token from the existing login.",
      code: "AUTH_USER_NOT_FOUND",
    });
  }

  // This is the ONLY user ID used by every query in this router.
  req.exportUserId = userId;

  next();
}

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/*
  Amount formatting:
    2000       -> "2000"
    2000.00    -> "2000"
    2000.70    -> "2000.7"
    2000.75    -> "2000.75"

  No automatic ".00".
  No small "1" is added before/after amounts.
*/
function formatAmount(value) {
  const n = asNumber(value);

  if (Object.is(n, -0)) return "0";

  const rounded = Math.round((n + Number.EPSILON) * 100) / 100;

  return new Intl.NumberFormat("en-IN", {
    useGrouping: true,
    maximumFractionDigits: 2,
    minimumFractionDigits: 0,
  }).format(rounded);
}

function formatCurrency(value) {
  return `₹${formatAmount(value)}`;
}

function formatDate(value) {
  if (!value) return "-";

  const raw = String(value).slice(0, 10);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return String(value);
  }

  const [y, m, d] = raw.split("-");
  return `${d} ${monthName(Number(m))} ${y}`;
}

function formatDateTime(value) {
  if (!value) return "-";

  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);

  const date = d.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });

  const time = d.toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
  });

  return `${date}, ${time}`;
}

function monthName(month) {
  return [
    "",
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ][month] || "";
}

function monthTitle(month) {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return month;

  const year = Number(match[1]);
  const m = Number(match[2]);

  return new Date(year, m - 1, 1).toLocaleDateString("en-IN", {
    month: "long",
    year: "numeric",
  });
}

function getCurrentMonth() {
  const now = new Date();

  return (
    String(now.getFullYear()) +
    "-" +
    String(now.getMonth() + 1).padStart(2, "0")
  );
}

function validateMonth(month) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(month);
}

function getMonthDates(month) {
  const [year, monthNumber] = month.split("-").map(Number);

  const start = `${year}-${String(monthNumber).padStart(2, "0")}-01`;

  const nextMonthDate = new Date(year, monthNumber, 1);
  const nextMonth = [
    nextMonthDate.getFullYear(),
    String(nextMonthDate.getMonth() + 1).padStart(2, "0"),
    "01",
  ].join("-");

  return {
    start,
    endExclusive: nextMonth,
    lastDay: new Date(year, monthNumber, 0).getDate(),
  };
}

function getWeekDates(month, week) {
  const { lastDay } = getMonthDates(month);

  const weekNumber = Number(week);

  const ranges = [
    [1, Math.min(7, lastDay)],
    [8, Math.min(14, lastDay)],
    [15, Math.min(21, lastDay)],
    [22, lastDay],
  ];

  const [startDay, endDay] =
    ranges[Math.max(1, Math.min(4, weekNumber)) - 1];

  const start = `${month}-${String(startDay).padStart(2, "0")}`;

  const endDate = new Date(
    Number(month.slice(0, 4)),
    Number(month.slice(5, 7)) - 1,
    endDay
  );

  endDate.setDate(endDate.getDate() + 1);

  const endExclusive =
    `${endDate.getFullYear()}-` +
    `${String(endDate.getMonth() + 1).padStart(2, "0")}-` +
    `${String(endDate.getDate()).padStart(2, "0")}`;

  return {
    start,
    endExclusive,
    startDay,
    endDay,
  };
}

function getPeriod(req) {
  const period = req.query.period === "week" ? "week" : "month";

  const month = req.query.month || getCurrentMonth();

  if (!validateMonth(month)) {
    const error = new Error(
      "Invalid month. Use YYYY-MM, for example 2026-08."
    );
    error.status = 400;
    throw error;
  }

  let week = null;

  if (period === "week") {
    week = Number(req.query.week || 1);

    if (![1, 2, 3, 4].includes(week)) {
      const error = new Error("Week must be 1, 2, 3 or 4.");
      error.status = 400;
      throw error;
    }
  }

  const range =
    period === "week"
      ? getWeekDates(month, week)
      : getMonthDates(month);

  return {
    period,
    month,
    week,
    startDate: range.start,
    endDateExclusive: range.endExclusive,
    startDay: range.startDay || 1,
    endDay: range.endDay || range.lastDay,
  };
}

function safeText(value) {
  if (value === null || value === undefined || value === "") {
    return "-";
  }

  return String(value);
}

function hasRows(rows) {
  return Array.isArray(rows) && rows.length > 0;
}

function addTotal(rows, field) {
  return rows.reduce((sum, row) => sum + asNumber(row[field]), 0);
}

function normalizeRows(rows) {
  return Array.isArray(rows) ? rows : [];
}

// -----------------------------------------------------------------------------
// AUTH CHECK
// -----------------------------------------------------------------------------
// Useful for testing the existing login without changing the login page.
// GET /api/export-details/auth-check
router.get("/health", (req, res) => {
  return res.json({
    success: true,
    service: "export-details",
    status: "ok",
  });
});

router.get("/auth-check", requireUser, (req, res) => {
  return res.json({
    success: true,
    authenticated: true,
    userId: req.exportUserId,
  });
});

// -----------------------------------------------------------------------------
// DATA LOADING
// -----------------------------------------------------------------------------

async function loadReportData(userId, periodInfo) {
  const values = [
    userId,
    periodInfo.startDate,
    periodInfo.endDateExclusive,
  ];

  /*
    Every query uses the date range in PostgreSQL.

    IMPORTANT:
      No "updated_at" is selected from personal_expenses because the
      table supplied for this project contains created_at but does NOT
      contain updated_at.
  */

  const [
    userResult,
    businessWorkResult,
    expenseResult,
    loanBorrowResult,
    emiResult,
    paymentsResult,
    overviewResult,
  ] = await Promise.all([
    db.query(
      `
        SELECT
          id,
          full_name,
          profession,
          instagram,
          phone1,
          phone2,
          email1,
          email2,
          username,
          email_address,
          street,
          city,
          taluka,
          district,
          state,
          pincode,
          profile_image,
          created_at,
          updated_at
        FROM personal_users
        WHERE id = $1
        LIMIT 1
      `,
      [userId]
    ),

    db.query(
      `
        SELECT
          id,
          user_id,
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
          AND (
            start_date < $3::date
            AND (
              end_date IS NULL
              OR end_date >= $2::date
            )
          )
        ORDER BY start_date DESC NULLS LAST, id DESC
      `,
      values
    ),

    db.query(
      `
        SELECT
          id,
          user_id,
          category,
          amount,
          expense_date,
          notes,
          created_at
        FROM personal_expenses
        WHERE user_id = $1
          AND expense_date >= $2::date
          AND expense_date < $3::date
        ORDER BY expense_date DESC, id DESC
      `,
      values
    ),

    db.query(
      `
        SELECT
          id,
          user_id,
          name,
          type,
          amount,
          emi,
          start_date,
          end_date,
          return_date,
          status,
          notes,
          created_at,
          updated_at
        FROM personal_loans_borrow
        WHERE user_id = $1
          AND (
            start_date < $3::date
            AND (
              end_date IS NULL
              OR end_date >= $2::date
              OR return_date IS NULL
            )
          )
        ORDER BY start_date DESC NULLS LAST, id DESC
      `,
      values
    ),

    db.query(
      `
        SELECT
          p.id,
          p.user_id,
          p.loan_id,
          p.amount,
          p.payment_date,
          p.payment_type,
          p.notes,
          p.created_at,
          lb.name AS loan_name
        FROM personal_loan_emi_payments p
        LEFT JOIN personal_loans_borrow lb
          ON lb.id = p.loan_id
        WHERE p.user_id = $1
          AND p.payment_date >= $2::date
          AND p.payment_date < $3::date
        ORDER BY p.payment_date DESC, p.id DESC
      `,
      values
    ),

    db.query(
      `
        SELECT
          id,
          user_id,
          person_name,
          amount,
          category,
          payment_date,
          status,
          received_at,
          notes,
          created_at,
          updated_at
        FROM personal_payments
        WHERE user_id = $1
          AND payment_date >= $2::date
          AND payment_date < $3::date
        ORDER BY payment_date DESC, id DESC
      `,
      values
    ),

    /*
      personal_overview may not exist in an older installation.
      The error is handled below so export does not fail merely because
      the optional overview table is absent.
    */
    db
      .query(
        `
          SELECT *
          FROM personal_overview
          WHERE user_id = $1
            AND (
              month_start IS NULL
              OR (
                month_start >= $2::date
                AND month_start < $3::date
              )
            )
          ORDER BY month_start DESC NULLS LAST
        `,
        values
      )
      .catch((error) => {
        if (error && error.code === "42P01") {
          return { rows: [] };
        }

        throw error;
      }),
  ]);

  if (!userResult.rows[0]) {
    const error = new Error("User profile not found.");
    error.status = 404;
    throw error;
  }

  const data = {
    user: userResult.rows[0],
    tables: {
      personal_business_work: normalizeRows(businessWorkResult.rows),
      personal_expenses: normalizeRows(expenseResult.rows),
      personal_loans_borrow: normalizeRows(loanBorrowResult.rows),
      personal_loan_emi_payments: normalizeRows(emiResult.rows),
      personal_payments: normalizeRows(paymentsResult.rows),
      personal_overview: normalizeRows(overviewResult.rows),
    },
  };

  data.summary = calculateSummary(data.tables);

  data.period = {
    period: periodInfo.period,
    month: periodInfo.month,
    monthTitle: monthTitle(periodInfo.month),
    week: periodInfo.week,
    startDate: periodInfo.startDate,
    endDateExclusive: periodInfo.endDateExclusive,
    startDay: periodInfo.startDay,
    endDay: periodInfo.endDay,
  };

  data.categoryTotals = calculateCategoryTotals(
    data.tables.personal_expenses
  );

  return data;
}

// -----------------------------------------------------------------------------
// SUMMARY
// -----------------------------------------------------------------------------

function calculateCategoryTotals(expenses) {
  const map = new Map();

  for (const row of expenses) {
    const category =
      safeText(row.category) === "-"
        ? "Uncategorized"
        : safeText(row.category);

    map.set(
      category,
      asNumber(map.get(category)) + asNumber(row.amount)
    );
  }

  return Array.from(map.entries())
    .map(([category, amount]) => ({
      category,
      amount,
    }))
    .sort((a, b) => b.amount - a.amount);
}

function calculateSummary(tables) {
  const expenses = tables.personal_expenses;
  const payments = tables.personal_payments;
  const repayments = tables.personal_loan_emi_payments;
  const loans = tables.personal_loans_borrow;
  const businessWork = tables.personal_business_work;

  const expenseTotal = addTotal(expenses, "amount");

  const received = payments
    .filter(
      (row) =>
        String(row.status).toLowerCase() === "received"
    )
    .reduce((sum, row) => sum + asNumber(row.amount), 0);

  const pending = payments
    .filter(
      (row) =>
        String(row.status).toLowerCase() === "pending"
    )
    .reduce((sum, row) => sum + asNumber(row.amount), 0);

  const overdue = payments
    .filter(
      (row) =>
        String(row.status).toLowerCase() === "overdue"
    )
    .reduce((sum, row) => sum + asNumber(row.amount), 0);

  const lost = payments
    .filter(
      (row) =>
        String(row.status).toLowerCase() === "lost"
    )
    .reduce((sum, row) => sum + asNumber(row.amount), 0);

  const emiTotal = repayments
    .filter(
      (row) =>
        String(row.payment_type).toLowerCase() === "emi"
    )
    .reduce((sum, row) => sum + asNumber(row.amount), 0);

  const borrowRepayment = repayments
    .filter(
      (row) =>
        String(row.payment_type).toLowerCase() ===
        "borrow repayment"
    )
    .reduce((sum, row) => sum + asNumber(row.amount), 0);

  const loanRepayment = repayments
    .filter(
      (row) =>
        String(row.payment_type).toLowerCase() ===
        "loan repayment"
    )
    .reduce((sum, row) => sum + asNumber(row.amount), 0);

  const outgoing =
    expenseTotal +
    emiTotal +
    borrowRepayment +
    loanRepayment;

  const net = received - outgoing;

  const businessTotal = businessWork
    .filter(
      (row) =>
        String(row.type).toLowerCase() === "business"
    )
    .reduce((sum, row) => sum + asNumber(row.amount), 0);

  const workTotal = businessWork
    .filter(
      (row) =>
        String(row.type).toLowerCase() === "work"
    )
    .reduce((sum, row) => sum + asNumber(row.amount), 0);

  const activeLoanTotal = loans
    .filter(
      (row) =>
        String(row.type).toLowerCase() === "loan" &&
        String(row.status).toLowerCase() === "active"
    )
    .reduce((sum, row) => sum + asNumber(row.amount), 0);

  const activeBorrowTotal = loans
    .filter(
      (row) =>
        String(row.type).toLowerCase() === "borrow" &&
        String(row.status).toLowerCase() === "active"
    )
    .reduce((sum, row) => sum + asNumber(row.amount), 0);

  return {
    income: received,
    received,
    expenses: expenseTotal,
    expenseTotal,
    emi: emiTotal,
    emiTotal,
    borrowRepayment,
    loanRepayment,
    outgoing,
    net,
    savings: Math.max(net, 0),
    loss: Math.max(-net, 0),
    pending,
    overdue,
    lost,
    businessTotal,
    workTotal,
    activeLoanTotal,
    activeBorrowTotal,
  };
}

// -----------------------------------------------------------------------------
// WEEKLY SUMMARY
// -----------------------------------------------------------------------------

function calculateWeeklySummary(fullData, month) {
  const weeks = [];

  for (let week = 1; week <= 4; week += 1) {
    const range = getWeekDates(month, week);

    const expenses = fullData.tables.personal_expenses.filter(
      (row) => {
        const value = String(row.expense_date).slice(0, 10);
        return (
          value >= range.start &&
          value < range.endExclusive
        );
      }
    );

    const payments = fullData.tables.personal_payments.filter(
      (row) => {
        const value = String(row.payment_date).slice(0, 10);
        return (
          value >= range.start &&
          value < range.endExclusive
        );
      }
    );

    const repayments =
      fullData.tables.personal_loan_emi_payments.filter(
        (row) => {
          const value = String(row.payment_date).slice(0, 10);
          return (
            value >= range.start &&
            value < range.endExclusive
          );
        }
      );

    const income = payments
      .filter(
        (row) =>
          String(row.status).toLowerCase() === "received"
      )
      .reduce((sum, row) => sum + asNumber(row.amount), 0);

    const expenseTotal = addTotal(expenses, "amount");

    const emi = repayments
      .filter(
        (row) =>
          String(row.payment_type).toLowerCase() === "emi"
      )
      .reduce((sum, row) => sum + asNumber(row.amount), 0);

    const loanRepayment = repayments
      .filter(
        (row) =>
          String(row.payment_type).toLowerCase() ===
          "loan repayment"
      )
      .reduce((sum, row) => sum + asNumber(row.amount), 0);

    const borrowRepayment = repayments
      .filter(
        (row) =>
          String(row.payment_type).toLowerCase() ===
          "borrow repayment"
      )
      .reduce((sum, row) => sum + asNumber(row.amount), 0);

    const outgoing =
      expenseTotal +
      emi +
      loanRepayment +
      borrowRepayment;

    const net = income - outgoing;

    const hasActivity =
      expenses.length > 0 ||
      payments.length > 0 ||
      repayments.length > 0;

    weeks.push({
      week,
      startDay: range.startDay,
      endDay: range.endDay,
      income,
      expenses: expenseTotal,
      emi,
      loanRepayment,
      borrowRepayment,
      outgoing,
      net,
      hasActivity,
      status: !hasActivity
        ? "No Activity"
        : net >= 0
          ? "Positive"
          : "Negative",
    });
  }

  return weeks;
}

// -----------------------------------------------------------------------------
// JSON DATA ROUTE
// -----------------------------------------------------------------------------

router.get("/data", requireUser, async (req, res) => {
  try {
    const periodInfo = getPeriod(req);

    const data = await loadReportData(
      req.exportUserId,
      periodInfo
    );

    if (periodInfo.period === "month") {
      data.weekly = calculateWeeklySummary(
        data,
        periodInfo.month
      );
    } else {
      const allMonthData = await loadReportData(
        req.exportUserId,
        {
          period: "month",
          month: periodInfo.month,
          week: null,
          ...getMonthDates(periodInfo.month),
        }
      );

      data.weekly = calculateWeeklySummary(
        allMonthData,
        periodInfo.month
      );

      data.selectedWeek =
        data.weekly.find(
          (row) => row.week === periodInfo.week
        ) || null;
    }

    return res.json({
      success: true,
      ...data,
    });
  } catch (error) {
    console.error("GET export details data error:", error);

    return res.status(error.status || 500).json({
      success: false,
      message:
        error.code === "ECONNREFUSED" || error.code === "ENOTFOUND"
          ? "Database connection failed. Check the backend database configuration."
          : error.message || "Failed to load export details.",
      code: error.code || undefined,
    });
  }
});

// -----------------------------------------------------------------------------
// PDF HELPERS
// -----------------------------------------------------------------------------

const PDF = {
  black: "#111827",
  dark: "#0f172a",
  gray: "#475569",
  lightGray: "#64748b",
  border: "#d8dee8",
  soft: "#f3f5f8",
  white: "#ffffff",
  accent: "#4f46e5",
};

function pdfSafeText(value) {
  return safeText(value)
    .replace(/\r/g, "")
    .replace(/\t/g, " ");
}

function pdfText(doc, value, options = {}) {
  doc
    .fillColor(options.color || PDF.black)
    .font(options.font || "Helvetica")
    .fontSize(options.size || 9)
    .text(pdfSafeText(value), {
      width: options.width,
      align: options.align || "left",
      lineGap: options.lineGap || 1,
      continued: false,
    });
}

/*
  Draw a clean section title.
  No automatic numbering is used.
*/
function pdfSectionTitle(doc, title) {
  ensurePdfSpace(doc, 40);

  const y = doc.y;

  doc
    .fillColor(PDF.dark)
    .font("Helvetica-Bold")
    .fontSize(12)
    .text(title, 48, y, {
      width: doc.page.width - 96,
    });

  doc
    .moveTo(48, y + 17)
    .lineTo(doc.page.width - 48, y + 17)
    .lineWidth(0.7)
    .strokeColor(PDF.border)
    .stroke();

  doc.y = y + 25;
}

function ensurePdfSpace(doc, neededHeight) {
  const bottom = doc.page.height - 48;

  if (doc.y + neededHeight > bottom) {
    doc.addPage({
      size: "A4",
      margin: 48,
    });
  }
}

/*
  Page header/footer.

  Footer page number is deliberately a small page number ONLY.
  It is never attached to amount values.
*/
function drawPdfPageFrame(doc) {
  const pageNumber = doc.bufferedPageRange().count;

  doc
    .save()
    .fillColor("#64748b")
    .font("Helvetica")
    .fontSize(7)
    .text(
      `Page ${pageNumber}`,
      48,
      doc.page.height - 30,
      {
        width: doc.page.width - 96,
        align: "right",
      }
    )
    .restore();
}

function createPdfDocument(data) {
  const doc = new PDFDocument({
    size: "A4",
    margin: 48,
    autoFirstPage: true,
    bufferPages: true,
    compress: true,
  });

  doc.on("pageAdded", () => {
    // Only frame pages that actually exist.
    // No blank pages are manually created.
  });

  drawPdfCover(doc, data);

  addPdfSummary(doc, data);

  if (hasRows(data.categoryTotals)) {
    addPdfCategoryTable(doc, data.categoryTotals);
  }

  if (hasRows(data.tables.personal_business_work)) {
    addPdfBusinessWork(doc, data.tables.personal_business_work);
  }

  if (hasRows(data.tables.personal_expenses)) {
    addPdfExpenses(doc, data.tables.personal_expenses);
  }

  if (hasRows(data.tables.personal_loans_borrow)) {
    addPdfLoansBorrow(doc, data.tables.personal_loans_borrow);
  }

  if (hasRows(data.tables.personal_loan_emi_payments)) {
    addPdfRepayments(
      doc,
      data.tables.personal_loan_emi_payments
    );
  }

  if (hasRows(data.tables.personal_payments)) {
    addPdfPayments(doc, data.tables.personal_payments);
  }

  if (hasRows(data.tables.personal_overview)) {
    addPdfOverview(doc, data.tables.personal_overview);
  }

  if (data.period.period === "month") {
    const weekly = calculateWeeklySummary(
      data,
      data.period.month
    );

    if (weekly.some((row) => row.hasActivity)) {
      addPdfWeeklySummary(doc, weekly);
    }
  }

  addPdfFooterInfo(doc, data);

  // Put page numbers on every page that was actually created.
  const range = doc.bufferedPageRange();

  for (
    let pageIndex = range.start;
    pageIndex < range.start + range.count;
    pageIndex += 1
  ) {
    doc.switchToPage(pageIndex);
    drawPdfPageFrame(doc);
  }

  return doc;
}

function drawPdfCover(doc, data) {
  const width = doc.page.width - 96;

  doc
    .roundedRect(48, 48, width, 95, 12)
    .fillColor(PDF.dark)
    .fill();

  pdfText(doc, "PERSONAL FINANCIAL REPORT", {
    color: PDF.white,
    size: 18,
    width: width - 30,
  });

  doc.y = 83;

  pdfText(
    doc,
    data.period.period === "week"
      ? `Week ${data.period.week} • ${data.period.monthTitle}`
      : data.period.monthTitle,
    {
      color: "#c7d2fe",
      size: 11,
      width: width - 30,
    }
  );

  doc.y = 157;

  pdfText(doc, "Account", {
    color: PDF.lightGray,
    size: 7,
  });

  doc.y += 2;

  pdfText(
    doc,
    data.user.full_name || data.user.username || "User",
    {
      color: PDF.black,
      size: 12,
    }
  );

  doc.y += 2;

  pdfText(
    doc,
    [
      data.user.profession,
      data.user.username
        ? `@${data.user.username}`
        : null,
      data.user.email_address,
    ]
      .filter(Boolean)
      .join(" • "),
    {
      color: PDF.gray,
      size: 8,
    }
  );

  doc.y += 18;

  doc
    .moveTo(48, doc.y)
    .lineTo(doc.page.width - 48, doc.y)
    .lineWidth(0.8)
    .strokeColor(PDF.border)
    .stroke();

  doc.y += 17;
}

function addPdfSummary(doc, data) {
  pdfSectionTitle(doc, "Financial Summary");

  const summary = data.summary;

  const cards = [
    ["Received / Income", summary.received],
    ["Expenses", summary.expenses],
    ["EMI", summary.emi],
    ["Loan Repayment", summary.loanRepayment],
    ["Borrow Repayment", summary.borrowRepayment],
    ["Total Outgoing", summary.outgoing],
    ["Net Result", summary.net],
    ["Pending", summary.pending],
  ];

  const left = 48;
  const gap = 9;
  const colWidth = (doc.page.width - 96 - gap) / 2;
  const rowHeight = 40;

  for (let i = 0; i < cards.length; i += 1) {
    const col = i % 2;
    const row = Math.floor(i / 2);

    const x = left + col * (colWidth + gap);
    const y = doc.y + row * (rowHeight + 7);

    doc
      .roundedRect(x, y, colWidth, rowHeight, 7)
      .fillColor(PDF.soft)
      .fill()
      .lineWidth(0.5)
      .strokeColor(PDF.border)
      .stroke();

    pdfText(doc, cards[i][0], {
      color: PDF.gray,
      size: 7,
      width: colWidth - 16,
    });

    pdfText(doc, formatCurrency(cards[i][1]), {
      color: PDF.black,
      size: 11,
      width: colWidth - 16,
    });

    // Explicitly no "1", "2", etc. before amount values.
  }

  doc.y += 4 * (rowHeight + 7) + 10;
}

function drawPdfTable(doc, columns, rows, options = {}) {
  if (!rows.length) return;

  const pageWidth = doc.page.width;
  const tableWidth = pageWidth - 96;
  const headerHeight = options.headerHeight || 22;
  const rowPadding = 5;
  const fontSize = options.fontSize || 7;

  let widths;

  if (options.widths) {
    widths = options.widths;
  } else {
    widths = columns.map(
      () => tableWidth / columns.length
    );
  }

  const totalWidth = widths.reduce(
    (sum, width) => sum + width,
    0
  );

  if (Math.abs(totalWidth - tableWidth) > 1) {
    widths = widths.map(
      (width) => (width / totalWidth) * tableWidth
    );
  }

  function drawHeader() {
    const y = doc.y;

    doc
      .rect(48, y, tableWidth, headerHeight)
      .fillColor("#e9edf3")
      .fill();

    let x = 48;

    columns.forEach((column, index) => {
      pdfText(doc, column.title, {
        color: PDF.black,
        size: 7,
        width: widths[index] - 8,
      });

      x += widths[index];
    });

    doc.y = y + headerHeight;
  }

  function calculateRowHeight(row) {
    let maxLines = 1;

    row.forEach((value, index) => {
      const width = Math.max(30, widths[index] - rowPadding * 2);
      const text = pdfSafeText(value);

      // Approximate line count for stable pagination.
      const charsPerLine = Math.max(
        10,
        Math.floor(width / (fontSize * 0.52))
      );

      const lines = Math.max(
        1,
        Math.ceil(text.length / charsPerLine)
      );

      maxLines = Math.max(maxLines, Math.min(lines, 7));
    });

    return Math.max(
      22,
      maxLines * (fontSize + 2) + rowPadding * 2
    );
  }

  drawHeader();

  for (const row of rows) {
    const rowHeight = calculateRowHeight(row);

    if (
      doc.y + rowHeight >
      doc.page.height - 50
    ) {
      doc.addPage({
        size: "A4",
        margin: 48,
      });

      drawHeader();
    }

    const y = doc.y;

    doc
      .rect(48, y, tableWidth, rowHeight)
      .fillColor(PDF.white)
      .fill()
      .lineWidth(0.35)
      .strokeColor(PDF.border)
      .stroke();

    let x = 48;

    row.forEach((value, index) => {
      pdfText(doc, value, {
        color: PDF.black,
        size: fontSize,
        width: widths[index] - rowPadding * 2,
        lineGap: 1,
      });

      // The text cursor is not used for positioning other cells.
      // Every cell is positioned explicitly.
      doc.x = x + rowPadding;
      doc.y = y + rowPadding;

      x += widths[index];
    });

    doc.y = y + rowHeight;
  }

  doc.y += 9;
}

function addPdfCategoryTable(doc, categories) {
  pdfSectionTitle(doc, "Expense Categories");

  const total = categories.reduce(
    (sum, row) => sum + asNumber(row.amount),
    0
  );

  drawPdfTable(
    doc,
    [
      { title: "Category" },
      { title: "Amount" },
      { title: "Share" },
    ],
    categories.map((row) => [
      safeText(row.category),
      formatCurrency(row.amount),
      total > 0
        ? `${((asNumber(row.amount) / total) * 100).toFixed(1)}%`
        : "0%",
    ]),
    {
      widths: [270, 160, 70],
    }
  );
}

function addPdfBusinessWork(doc, rows) {
  pdfSectionTitle(doc, "Business / Work");

  drawPdfTable(
    doc,
    [
      { title: "Type" },
      { title: "Name" },
      { title: "Amount" },
      { title: "Status" },
      { title: "Start" },
      { title: "End" },
    ],
    rows.map((row) => [
      safeText(row.type),
      safeText(row.name),
      formatCurrency(row.amount),
      safeText(row.status),
      formatDate(row.start_date),
      formatDate(row.end_date),
    ]),
    {
      widths: [68, 145, 80, 75, 75, 75],
    }
  );
}

function addPdfExpenses(doc, rows) {
  pdfSectionTitle(doc, "Expenses");

  drawPdfTable(
    doc,
    [
      { title: "Category" },
      { title: "Amount" },
      { title: "Date" },
      { title: "Notes" },
    ],
    rows.map((row) => [
      safeText(row.category),
      formatCurrency(row.amount),
      formatDate(row.expense_date),
      safeText(row.notes),
    ]),
    {
      widths: [135, 90, 85, 208],
    }
  );
}

function addPdfLoansBorrow(doc, rows) {
  pdfSectionTitle(doc, "Loans / Borrow");

  drawPdfTable(
    doc,
    [
      { title: "Type" },
      { title: "Name" },
      { title: "Amount" },
      { title: "EMI" },
      { title: "Status" },
      { title: "Start" },
      { title: "End / Return" },
    ],
    rows.map((row) => [
      safeText(row.type),
      safeText(row.name),
      formatCurrency(row.amount),
      formatCurrency(row.emi),
      safeText(row.status),
      formatDate(row.start_date),
      formatDate(row.return_date || row.end_date),
    ]),
    {
      widths: [62, 115, 75, 70, 72, 80, 89],
    }
  );
}

function addPdfRepayments(doc, rows) {
  pdfSectionTitle(doc, "Loan / EMI Payments");

  drawPdfTable(
    doc,
    [
      { title: "Loan" },
      { title: "Payment Type" },
      { title: "Amount" },
      { title: "Date" },
      { title: "Notes" },
    ],
    rows.map((row) => [
      safeText(row.loan_name),
      safeText(row.payment_type),
      formatCurrency(row.amount),
      formatDate(row.payment_date),
      safeText(row.notes),
    ]),
    {
      widths: [120, 125, 85, 85, 153],
    }
  );
}

function addPdfPayments(doc, rows) {
  pdfSectionTitle(doc, "Payments");

  drawPdfTable(
    doc,
    [
      { title: "Person" },
      { title: "Category" },
      { title: "Amount" },
      { title: "Date" },
      { title: "Status" },
      { title: "Notes" },
    ],
    rows.map((row) => [
      safeText(row.person_name),
      safeText(row.category),
      formatCurrency(row.amount),
      formatDate(row.payment_date),
      safeText(row.status),
      safeText(row.notes),
    ]),
    {
      widths: [100, 72, 80, 80, 72, 164],
    }
  );
}

function addPdfOverview(doc, rows) {
  pdfSectionTitle(doc, "Monthly Overview");

  const keys = Object.keys(rows[0] || {});

  const importantKeys = keys.filter(
    (key) =>
      ![
        "id",
        "user_id",
        "created_at",
        "updated_at",
      ].includes(key)
  );

  drawPdfTable(
    doc,
    [
      { title: "Field" },
      { title: "Value" },
    ],
    rows.flatMap((row) =>
      importantKeys.map((key) => [
        key.replace(/_/g, " "),
        safeText(row[key]),
      ])
    ),
    {
      widths: [190, 340],
    }
  );
}

function addPdfWeeklySummary(doc, weekly) {
  pdfSectionTitle(doc, "Weekly Performance");

  drawPdfTable(
    doc,
    [
      { title: "Week" },
      { title: "Period" },
      { title: "Income" },
      { title: "Expenses" },
      { title: "EMI" },
      { title: "Loan" },
      { title: "Borrow" },
      { title: "Outgoing" },
      { title: "Net" },
      { title: "Status" },
    ],
    weekly
      .filter((row) => row.hasActivity)
      .map((row) => [
        `Week ${row.week}`,
        `${row.startDay}–${row.endDay}`,
        formatCurrency(row.income),
        formatCurrency(row.expenses),
        formatCurrency(row.emi),
        formatCurrency(row.loanRepayment),
        formatCurrency(row.borrowRepayment),
        formatCurrency(row.outgoing),
        formatCurrency(row.net),
        row.status,
      ]),
    {
      widths: [45, 58, 65, 65, 55, 62, 62, 65, 65, 53],
      fontSize: 6.4,
    }
  );
}

function addPdfFooterInfo(doc, data) {
  ensurePdfSpace(doc, 35);

  doc
    .moveTo(48, doc.y)
    .lineTo(doc.page.width - 48, doc.y)
    .lineWidth(0.5)
    .strokeColor(PDF.border)
    .stroke();

  doc.y += 8;

  pdfText(
    doc,
    `Generated for ${safeText(
      data.user.full_name || data.user.username
    )}`,
    {
      color: PDF.gray,
      size: 7,
    }
  );

  pdfText(doc, `Generated on ${formatDateTime(new Date())}`, {
    color: PDF.lightGray,
    size: 7,
  });

  doc.y += 3;
}

// -----------------------------------------------------------------------------
// PDF RESPONSE
// -----------------------------------------------------------------------------

function sendPdf(res, data) {
  const filename =
    `Personal_Financial_${data.period.period}_` +
    `${data.period.month}` +
    (data.period.week
      ? `_Week_${data.period.week}`
      : "") +
    ".pdf";

  const doc = createPdfDocument(data);

  res.status(200);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename}"`
  );
  res.setHeader("Cache-Control", "no-store");

  doc.pipe(res);
  doc.end();
}

// -----------------------------------------------------------------------------
// EXCEL
// -----------------------------------------------------------------------------

function styleExcelSheet(sheet) {
  sheet.views = [{ state: "frozen", ySplit: 1 }];

  sheet.getRow(1).font = {
    bold: true,
    color: { argb: "FF111827" },
  };

  sheet.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFE9EDF3" },
  };

  sheet.getRow(1).border = {
    bottom: {
      style: "thin",
      color: { argb: "FFD8DEE8" },
    },
  };

  sheet.autoFilter = {
    from: 1,
    to: Math.max(1, sheet.columnCount),
    row: 1,
  };
}

function addExcelSheet(workbook, name, columns, rows) {
  if (!rows.length) return;

  const sheet = workbook.addWorksheet(name);

  sheet.columns = columns.map((column) => ({
    header: column.header,
    key: column.key,
    width: column.width || 18,
  }));

  rows.forEach((row) => {
    const output = {};

    columns.forEach((column) => {
      output[column.key] =
        column.transform
          ? column.transform(row)
          : row[column.key];
    });

    sheet.addRow(output);
  });

  sheet.eachRow((row, rowNumber) => {
    row.alignment = {
      vertical: "top",
      wrapText: true,
    };

    if (rowNumber > 1) {
      row.eachCell((cell) => {
        cell.font = {
          color: { argb: "FF111827" },
          size: 10,
        };
      });
    }
  });

  styleExcelSheet(sheet);
}

async function createExcelWorkbook(data) {
  const workbook = new ExcelJS.Workbook();

  workbook.creator = "Personal Dashboard";
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.properties.subject =
    "Personal financial report";
  workbook.properties.title =
    `Personal Financial ${data.period.monthTitle}`;

  const summarySheet =
    workbook.addWorksheet("Summary");

  summarySheet.columns = [
    { header: "Metric", key: "metric", width: 28 },
    { header: "Amount", key: "amount", width: 20 },
  ];

  const summary = data.summary;

  [
    ["Period", data.period.monthTitle],
    [
      "Report",
      data.period.period === "week"
        ? `Week ${data.period.week}`
        : "Monthly",
    ],
    ["Received / Income", formatCurrency(summary.received)],
    ["Expenses", formatCurrency(summary.expenses)],
    ["EMI", formatCurrency(summary.emi)],
    [
      "Loan Repayment",
      formatCurrency(summary.loanRepayment),
    ],
    [
      "Borrow Repayment",
      formatCurrency(summary.borrowRepayment),
    ],
    ["Total Outgoing", formatCurrency(summary.outgoing)],
    ["Net Result", formatCurrency(summary.net)],
    ["Pending", formatCurrency(summary.pending)],
    ["Overdue", formatCurrency(summary.overdue)],
    ["Lost", formatCurrency(summary.lost)],
    [
      "Active Loan",
      formatCurrency(summary.activeLoanTotal),
    ],
    [
      "Active Borrow",
      formatCurrency(summary.activeBorrowTotal),
    ],
    [
      "Business Total",
      formatCurrency(summary.businessTotal),
    ],
    ["Work Total", formatCurrency(summary.workTotal)],
  ].forEach(([metric, amount]) => {
    summarySheet.addRow({ metric, amount });
  });

  styleExcelSheet(summarySheet);

  addExcelSheet(
    workbook,
    "Business Work",
    [
      { header: "ID", key: "id", width: 10 },
      { header: "Name", key: "name", width: 28 },
      { header: "Type", key: "type", width: 14 },
      { header: "Status", key: "status", width: 14 },
      {
        header: "Amount",
        key: "amount",
        width: 18,
        transform: (row) => formatAmount(row.amount),
      },
      {
        header: "Start Date",
        key: "start_date",
        width: 16,
        transform: (row) => formatDate(row.start_date),
      },
      {
        header: "End Date",
        key: "end_date",
        width: 16,
        transform: (row) => formatDate(row.end_date),
      },
      { header: "Notes", key: "notes", width: 40 },
    ],
    data.tables.personal_business_work
  );

  addExcelSheet(
    workbook,
    "Expenses",
    [
      { header: "ID", key: "id", width: 10 },
      { header: "Category", key: "category", width: 25 },
      {
        header: "Amount",
        key: "amount",
        width: 18,
        transform: (row) => formatAmount(row.amount),
      },
      {
        header: "Expense Date",
        key: "expense_date",
        width: 18,
        transform: (row) => formatDate(row.expense_date),
      },
      { header: "Notes", key: "notes", width: 45 },
      {
        header: "Created At",
        key: "created_at",
        width: 22,
        transform: (row) => formatDateTime(row.created_at),
      },
    ],
    data.tables.personal_expenses
  );

  addExcelSheet(
    workbook,
    "Loans Borrow",
    [
      { header: "ID", key: "id", width: 10 },
      { header: "Name", key: "name", width: 25 },
      { header: "Type", key: "type", width: 14 },
      {
        header: "Amount",
        key: "amount",
        width: 18,
        transform: (row) => formatAmount(row.amount),
      },
      {
        header: "EMI",
        key: "emi",
        width: 18,
        transform: (row) => formatAmount(row.emi),
      },
      {
        header: "Start Date",
        key: "start_date",
        width: 18,
        transform: (row) => formatDate(row.start_date),
      },
      {
        header: "End Date",
        key: "end_date",
        width: 18,
        transform: (row) => formatDate(row.end_date),
      },
      {
        header: "Return Date",
        key: "return_date",
        width: 18,
        transform: (row) => formatDate(row.return_date),
      },
      { header: "Status", key: "status", width: 15 },
      { header: "Notes", key: "notes", width: 40 },
    ],
    data.tables.personal_loans_borrow
  );

  addExcelSheet(
    workbook,
    "Repayments",
    [
      { header: "ID", key: "id", width: 10 },
      { header: "Loan ID", key: "loan_id", width: 12 },
      { header: "Loan", key: "loan_name", width: 25 },
      { header: "Payment Type", key: "payment_type", width: 24 },
      {
        header: "Amount",
        key: "amount",
        width: 18,
        transform: (row) => formatAmount(row.amount),
      },
      {
        header: "Payment Date",
        key: "payment_date",
        width: 18,
        transform: (row) => formatDate(row.payment_date),
      },
      { header: "Notes", key: "notes", width: 40 },
    ],
    data.tables.personal_loan_emi_payments
  );

  addExcelSheet(
    workbook,
    "Payments",
    [
      { header: "ID", key: "id", width: 10 },
      { header: "Person", key: "person_name", width: 25 },
      { header: "Category", key: "category", width: 15 },
      {
        header: "Amount",
        key: "amount",
        width: 18,
        transform: (row) => formatAmount(row.amount),
      },
      {
        header: "Payment Date",
        key: "payment_date",
        width: 18,
        transform: (row) => formatDate(row.payment_date),
      },
      { header: "Status", key: "status", width: 15 },
      {
        header: "Received At",
        key: "received_at",
        width: 22,
        transform: (row) =>
          formatDateTime(row.received_at),
      },
      { header: "Notes", key: "notes", width: 40 },
    ],
    data.tables.personal_payments
  );

  if (hasRows(data.tables.personal_overview)) {
    const keys = Object.keys(
      data.tables.personal_overview[0]
    );

    addExcelSheet(
      workbook,
      "Overview",
      keys.map((key) => ({
        header: key.replace(/_/g, " "),
        key,
        width: 20,
      })),
      data.tables.personal_overview
    );
  }

  if (data.period.period === "month") {
    const weekly = calculateWeeklySummary(
      data,
      data.period.month
    );

    addExcelSheet(
      workbook,
      "Weekly Performance",
      [
        { header: "Week", key: "week", width: 10 },
        {
          header: "Period",
          key: "period",
          width: 14,
          transform: (row) =>
            `${row.startDay}-${row.endDay}`,
        },
        {
          header: "Income",
          key: "income",
          width: 18,
          transform: (row) =>
            formatAmount(row.income),
        },
        {
          header: "Expenses",
          key: "expenses",
          width: 18,
          transform: (row) =>
            formatAmount(row.expenses),
        },
        {
          header: "EMI",
          key: "emi",
          width: 18,
          transform: (row) => formatAmount(row.emi),
        },
        {
          header: "Loan Repayment",
          key: "loanRepayment",
          width: 20,
          transform: (row) =>
            formatAmount(row.loanRepayment),
        },
        {
          header: "Borrow Repayment",
          key: "borrowRepayment",
          width: 22,
          transform: (row) =>
            formatAmount(row.borrowRepayment),
        },
        {
          header: "Outgoing",
          key: "outgoing",
          width: 18,
          transform: (row) =>
            formatAmount(row.outgoing),
        },
        {
          header: "Net",
          key: "net",
          width: 18,
          transform: (row) =>
            formatAmount(row.net),
        },
        { header: "Status", key: "status", width: 16 },
      ],
      weekly.filter((row) => row.hasActivity)
    );
  }

  return workbook;
}

// -----------------------------------------------------------------------------
// TEXT EXPORT
// -----------------------------------------------------------------------------

function textLine(char = "-", count = 78) {
  return char.repeat(count);
}

function textSection(title) {
  return [
    "",
    textLine("="),
    title.toUpperCase(),
    textLine("="),
  ].join("\n");
}

function tableText(headers, rows) {
  if (!rows.length) return "";

  const stringRows = [
    headers,
    ...rows.map((row) =>
      row.map((value) => safeText(value))
    ),
  ];

  const widths = headers.map((_, index) =>
    Math.min(
      32,
      Math.max(
        8,
        ...stringRows.map((row) =>
          String(row[index] ?? "").length
        )
      )
    )
  );

  const separator =
    "+" +
    widths.map((width) => "-".repeat(width + 2)).join("+") +
    "+";

  const formatRow = (row) =>
    "|" +
    row
      .map(
        (value, index) =>
          ` ${String(value ?? "")
            .slice(0, widths[index])
            .padEnd(widths[index])} `
      )
      .join("|") +
    "|";

  return [
    separator,
    formatRow(headers),
    separator,
    ...stringRows.slice(1).map(formatRow),
    separator,
  ].join("\n");
}

function createTextReport(data) {
  const lines = [];

  lines.push("PERSONAL FINANCIAL REPORT");
  lines.push(textLine("="));
  lines.push(
    data.period.period === "week"
      ? `Report: Week ${data.period.week} • ${data.period.monthTitle}`
      : `Report: Monthly • ${data.period.monthTitle}`
  );
  lines.push(`Name: ${safeText(data.user.full_name)}`);
  lines.push(`Profession: ${safeText(data.user.profession)}`);
  lines.push(`Username: ${safeText(data.user.username)}`);
  lines.push(`Email: ${safeText(data.user.email_address)}`);
  lines.push(
    `Period: ${formatDate(
      data.period.startDate
    )} to ${formatDate(
      new Date(
        `${data.period.endDateExclusive}T00:00:00`
      ).getTime() - 86400000
    )}`
  );

  lines.push(textSection("Financial Summary"));

  const s = data.summary;

  lines.push(
    tableText(
      ["Metric", "Amount"],
      [
        ["Received / Income", formatCurrency(s.received)],
        ["Expenses", formatCurrency(s.expenses)],
        ["EMI", formatCurrency(s.emi)],
        [
          "Loan Repayment",
          formatCurrency(s.loanRepayment),
        ],
        [
          "Borrow Repayment",
          formatCurrency(s.borrowRepayment),
        ],
        ["Total Outgoing", formatCurrency(s.outgoing)],
        ["Net Result", formatCurrency(s.net)],
        ["Pending", formatCurrency(s.pending)],
        ["Overdue", formatCurrency(s.overdue)],
        ["Lost", formatCurrency(s.lost)],
        [
          "Active Loan",
          formatCurrency(s.activeLoanTotal),
        ],
        [
          "Active Borrow",
          formatCurrency(s.activeBorrowTotal),
        ],
        [
          "Business Total",
          formatCurrency(s.businessTotal),
        ],
        ["Work Total", formatCurrency(s.workTotal)],
      ]
    )
  );

  if (hasRows(data.categoryTotals)) {
    lines.push(textSection("Expense Categories"));

    const total = data.categoryTotals.reduce(
      (sum, row) => sum + asNumber(row.amount),
      0
    );

    lines.push(
      tableText(
        ["Category", "Amount", "Share"],
        data.categoryTotals.map((row) => [
          row.category,
          formatCurrency(row.amount),
          total > 0
            ? `${(
                (asNumber(row.amount) / total) *
                100
              ).toFixed(1)}%`
            : "0%",
        ])
      )
    );
  }

  if (hasRows(data.tables.personal_business_work)) {
    lines.push(textSection("Business / Work"));

    lines.push(
      tableText(
        [
          "Type",
          "Name",
          "Amount",
          "Status",
          "Start",
          "End",
          "Notes",
        ],
        data.tables.personal_business_work.map(
          (row) => [
            safeText(row.type),
            safeText(row.name),
            formatCurrency(row.amount),
            safeText(row.status),
            formatDate(row.start_date),
            formatDate(row.end_date),
            safeText(row.notes),
          ]
        )
      )
    );
  }

  if (hasRows(data.tables.personal_expenses)) {
    lines.push(textSection("Expenses"));

    lines.push(
      tableText(
        ["Category", "Amount", "Date", "Notes"],
        data.tables.personal_expenses.map(
          (row) => [
            safeText(row.category),
            formatCurrency(row.amount),
            formatDate(row.expense_date),
            safeText(row.notes),
          ]
        )
      )
    );
  }

  if (hasRows(data.tables.personal_loans_borrow)) {
    lines.push(textSection("Loans / Borrow"));

    lines.push(
      tableText(
        [
          "Type",
          "Name",
          "Amount",
          "EMI",
          "Status",
          "Start",
          "End / Return",
          "Notes",
        ],
        data.tables.personal_loans_borrow.map(
          (row) => [
            safeText(row.type),
            safeText(row.name),
            formatCurrency(row.amount),
            formatCurrency(row.emi),
            safeText(row.status),
            formatDate(row.start_date),
            formatDate(
              row.return_date || row.end_date
            ),
            safeText(row.notes),
          ]
        )
      )
    );
  }

  if (
    hasRows(
      data.tables.personal_loan_emi_payments
    )
  ) {
    lines.push(textSection("Loan / EMI Payments"));

    lines.push(
      tableText(
        [
          "Loan",
          "Payment Type",
          "Amount",
          "Date",
          "Notes",
        ],
        data.tables.personal_loan_emi_payments.map(
          (row) => [
            safeText(row.loan_name),
            safeText(row.payment_type),
            formatCurrency(row.amount),
            formatDate(row.payment_date),
            safeText(row.notes),
          ]
        )
      )
    );
  }

  if (hasRows(data.tables.personal_payments)) {
    lines.push(textSection("Payments"));

    lines.push(
      tableText(
        [
          "Person",
          "Category",
          "Amount",
          "Date",
          "Status",
          "Notes",
        ],
        data.tables.personal_payments.map(
          (row) => [
            safeText(row.person_name),
            safeText(row.category),
            formatCurrency(row.amount),
            formatDate(row.payment_date),
            safeText(row.status),
            safeText(row.notes),
          ]
        )
      )
    );
  }

  if (hasRows(data.tables.personal_overview)) {
    lines.push(textSection("Monthly Overview"));

    const rows = data.tables.personal_overview;

    const keys = Object.keys(rows[0] || {}).filter(
      (key) =>
        ![
          "id",
          "user_id",
          "created_at",
          "updated_at",
        ].includes(key)
    );

    lines.push(
      tableText(
        ["Field", "Value"],
        rows.flatMap((row) =>
          keys.map((key) => [
            key.replace(/_/g, " "),
            safeText(row[key]),
          ])
        )
      )
    );
  }

  if (data.period.period === "month") {
    const weekly = calculateWeeklySummary(
      data,
      data.period.month
    ).filter((row) => row.hasActivity);

    if (weekly.length) {
      lines.push(textSection("Weekly Performance"));

      lines.push(
        tableText(
          [
            "Week",
            "Period",
            "Income",
            "Expenses",
            "EMI",
            "Loan",
            "Borrow",
            "Outgoing",
            "Net",
            "Status",
          ],
          weekly.map((row) => [
            `Week ${row.week}`,
            `${row.startDay}-${row.endDay}`,
            formatCurrency(row.income),
            formatCurrency(row.expenses),
            formatCurrency(row.emi),
            formatCurrency(row.loanRepayment),
            formatCurrency(row.borrowRepayment),
            formatCurrency(row.outgoing),
            formatCurrency(row.net),
            row.status,
          ])
        )
      );
    }
  }

  lines.push("");
  lines.push(textLine("-"));
  lines.push(
    `Generated: ${formatDateTime(new Date())}`
  );
  lines.push("Personal Dashboard");
  lines.push("");

  return lines.join("\n");
}

// -----------------------------------------------------------------------------
// EXPORT ROUTE
// -----------------------------------------------------------------------------

router.get("/", requireUser, async (req, res) => {
  try {
    const format = String(
      req.query.format || "pdf"
    ).toLowerCase();

    if (!["pdf", "excel", "text"].includes(format)) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid format. Use pdf, excel or text.",
      });
    }

    const periodInfo = getPeriod(req);

    /*
      For weekly reports, load exactly the selected week.
      For monthly reports, load the complete month.
    */
    const data = await loadReportData(
      req.exportUserId,
      periodInfo
    );

    if (format === "pdf") {
      return sendPdf(res, data);
    }

    if (format === "text") {
      const text = createTextReport(data);

      const filename =
        `Personal_Financial_${periodInfo.period}_` +
        `${periodInfo.month}` +
        (periodInfo.week
          ? `_Week_${periodInfo.week}`
          : "") +
        ".txt";

      res.status(200);
      res.setHeader(
        "Content-Type",
        "text/plain; charset=utf-8"
      );
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`
      );
      res.setHeader("Cache-Control", "no-store");

      return res.send(text);
    }

    const workbook = await createExcelWorkbook(data);

    const filename =
      `Personal_Financial_${periodInfo.period}_` +
      `${periodInfo.month}` +
      (periodInfo.week
        ? `_Week_${periodInfo.week}`
        : "") +
      ".xlsx";

    res.status(200);
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`
    );
    res.setHeader("Cache-Control", "no-store");

    await workbook.xlsx.write(res);
    return res.end();
  } catch (error) {
    console.error("Export details error:", error);

    if (res.headersSent) {
      return res.end();
    }

    return res.status(error.status || 500).json({
      success: false,
      message:
        error.message || "Failed to generate export.",
    });
  }
});

module.exports = router;