// routes/exportDetailsApi.js
// Export Details API
// Professional PDF + Excel + TXT exports
//
// Exports:
// 1. Selected month complete summary
// 2. Weekly performance
// 3. Monthly performance
// 4. Overview details
//
// PDF:
// - Clean professional layout
// - No clipped/hidden text
// - Automatic page breaks
// - Summary cards
// - Pie-chart style visual sections
// - Weekly/monthly tables
//
// Excel:
// - Multiple professional worksheets
// - Overview / Summary / Weekly / Monthly / Expenses / Payments / Loans
// - Auto column widths
// - Filters and frozen headers
//
// TXT:
// - Clean readable plain-text report
//
// Required packages:
// npm install pdfkit exceljs jsonwebtoken
//
// PostgreSQL + Express + JWT

const express = require("express");
const jwt = require("jsonwebtoken");
const PDFDocument = require("pdfkit");
const ExcelJS = require("exceljs");

const router = express.Router();
const db = require("../db.js");

const JWT_SECRET =
  process.env.JWT_SECRET || "your-secret-key";

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

  const [year, monthNumber] =
    month.split("-").map(Number);

  if (
    monthNumber < 1 ||
    monthNumber > 12
  ) {
    return null;
  }

  const monthStart =
    `${year}-${String(monthNumber).padStart(2, "0")}-01`;

  const nextYear =
    monthNumber === 12
      ? year + 1
      : year;

  const nextMonth =
    monthNumber === 12
      ? 1
      : monthNumber + 1;

  const nextMonthStart =
    `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`;

  return {
    monthStart,
    nextMonthStart,
  };
};

const toNumber = (value) =>
  Number(value || 0);

const money = (value) =>
  `₹${toNumber(value).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const safeText = (value) =>
  value === null ||
  value === undefined ||
  value === ""
    ? "-"
    : String(value);

const statusFromTotals = (
  income,
  outgoing
) => {
  const net =
    income - outgoing;

  if (
    income === 0 &&
    outgoing === 0
  ) {
    return "No Activity";
  }

  if (net > 0) return "Profit";
  if (net < 0) return "Loss";

  return "Break Even";
};

// ============================================================
// FETCH COMPLETE EXPORT DATA
// ============================================================

const getExportData = async (
  userId,
  month
) => {
  const range =
    getMonthRange(month);

  if (!range) {
    throw new Error(
      "Invalid month. Use YYYY-MM."
    );
  }

  // ----------------------------------------------------------
  // User
  // ----------------------------------------------------------

  const userResult =
    await db.query(
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
        pincode
      FROM personal_users
      WHERE id = $1
      `,
      [userId]
    );

  if (
    userResult.rows.length === 0
  ) {
    throw new Error(
      "User not found"
    );
  }

  // ----------------------------------------------------------
  // Overview
  // ----------------------------------------------------------

  const overviewResult =
    await db.query(
      `
      SELECT
        total_business,
        total_works,
        business_payment,
        work_payment
      FROM personal_overview
      WHERE user_id = $1
      ORDER BY id DESC
      LIMIT 1
      `,
      [userId]
    );

  // ----------------------------------------------------------
  // Payments
  // ----------------------------------------------------------

  const paymentsResult =
    await db.query(
      `
      SELECT
        id,
        person_name,
        amount,
        category,
        payment_date,
        received_at,
        status,
        notes
      FROM personal_payments
      WHERE user_id = $1
        AND payment_date >= $2::DATE
        AND payment_date < $3::DATE
      ORDER BY payment_date ASC, id ASC
      `,
      [
        userId,
        range.monthStart,
        range.nextMonthStart,
      ]
    );

  // ----------------------------------------------------------
  // Expenses
  // ----------------------------------------------------------

  const expensesResult =
    await db.query(
      `
      SELECT
        id,
        category,
        amount,
        expense_date,
        notes
      FROM personal_expenses
      WHERE user_id = $1
        AND expense_date >= $2::DATE
        AND expense_date < $3::DATE
      ORDER BY expense_date ASC, id ASC
      `,
      [
        userId,
        range.monthStart,
        range.nextMonthStart,
      ]
    );

  // ----------------------------------------------------------
  // Loans / Borrow
  // ----------------------------------------------------------

  const loansResult =
    await db.query(
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
        notes
      FROM personal_loans_borrow
      WHERE user_id = $1
      ORDER BY
        CASE
          WHEN type = 'Loan'
            THEN end_date
          ELSE return_date
        END ASC NULLS LAST,
        id ASC
      `,
      [userId]
    );

  // ----------------------------------------------------------
  // Repayments
  // ----------------------------------------------------------

  const repaymentsResult =
    await db.query(
      `
      SELECT
        id,
        loan_id,
        amount,
        payment_date,
        payment_type,
        notes
      FROM personal_loan_emi_payments
      WHERE user_id = $1
        AND payment_date >= $2::DATE
        AND payment_date < $3::DATE
      ORDER BY payment_date ASC, id ASC
      `,
      [
        userId,
        range.monthStart,
        range.nextMonthStart,
      ]
    );

  // ----------------------------------------------------------
  // Weekly performance
  // ----------------------------------------------------------

  const weekly = [1, 2, 3, 4, 5].map(
    (week) => ({
      week,
      income: 0,
      expenses: 0,
      loan_emi: 0,
      loan_repayment: 0,
      borrow_repayment: 0,
      pending: 0,
      overdue: 0,
      lost: 0,
      outgoing: 0,
      net: 0,
      status: "No Activity",
    })
  );

  expensesResult.rows.forEach(
    (row) => {
      const day =
        new Date(
          `${row.expense_date}T00:00:00Z`
        ).getUTCDate();

      const week =
        day <= 7
          ? 1
          : day <= 14
            ? 2
            : day <= 21
              ? 3
              : day <= 28
                ? 4
                : 5;

      weekly[week - 1].expenses +=
        toNumber(row.amount);
    }
  );

  paymentsResult.rows.forEach(
    (row) => {
      const day =
        new Date(
          `${row.payment_date}T00:00:00Z`
        ).getUTCDate();

      const week =
        day <= 7
          ? 1
          : day <= 14
            ? 2
            : day <= 21
              ? 3
              : day <= 28
                ? 4
                : 5;

      if (row.status === "Received") {
        weekly[week - 1].income +=
          toNumber(row.amount);
      }

      if (row.status === "Pending") {
        weekly[week - 1].pending +=
          toNumber(row.amount);
      }

      if (row.status === "Overdue") {
        weekly[week - 1].overdue +=
          toNumber(row.amount);
      }

      if (row.status === "Lost") {
        weekly[week - 1].lost +=
          toNumber(row.amount);
      }
    }
  );

  repaymentsResult.rows.forEach(
    (row) => {
      const day =
        new Date(
          `${row.payment_date}T00:00:00Z`
        ).getUTCDate();

      const week =
        day <= 7
          ? 1
          : day <= 14
            ? 2
            : day <= 21
              ? 3
              : day <= 28
                ? 4
                : 5;

      const amount =
        toNumber(row.amount);

      if (
        row.payment_type === "EMI"
      ) {
        weekly[week - 1].loan_emi +=
          amount;
      }

      if (
        row.payment_type ===
        "Loan Repayment"
      ) {
        weekly[week - 1]
          .loan_repayment += amount;
      }

      if (
        row.payment_type ===
        "Borrow Repayment"
      ) {
        weekly[week - 1]
          .borrow_repayment += amount;
      }
    }
  );

  weekly.forEach((row) => {
    row.outgoing =
      row.expenses +
      row.loan_emi +
      row.loan_repayment +
      row.borrow_repayment;

    row.net =
      row.income -
      row.outgoing;

    row.status =
      statusFromTotals(
        row.income,
        row.outgoing
      );
  });

  // ----------------------------------------------------------
  // Monthly totals
  // ----------------------------------------------------------

  const totalIncome =
    weekly.reduce(
      (sum, row) =>
        sum + row.income,
      0
    );

  const totalExpenses =
    weekly.reduce(
      (sum, row) =>
        sum + row.expenses,
      0
    );

  const totalLoanEmi =
    weekly.reduce(
      (sum, row) =>
        sum + row.loan_emi,
      0
    );

  const totalLoanRepayment =
    weekly.reduce(
      (sum, row) =>
        sum + row.loan_repayment,
      0
    );

  const totalBorrowRepayment =
    weekly.reduce(
      (sum, row) =>
        sum + row.borrow_repayment,
      0
    );

  const totalPending =
    weekly.reduce(
      (sum, row) =>
        sum + row.pending,
      0
    );

  const totalOverdue =
    weekly.reduce(
      (sum, row) =>
        sum + row.overdue,
      0
    );

  const totalLost =
    weekly.reduce(
      (sum, row) =>
        sum + row.lost,
      0
    );

  const totalOutgoing =
    totalExpenses +
    totalLoanEmi +
    totalLoanRepayment +
    totalBorrowRepayment;

  const net =
    totalIncome -
    totalOutgoing;

  // ----------------------------------------------------------
  // Expense categories
  // ----------------------------------------------------------

  const categoryMap =
    new Map();

  expensesResult.rows.forEach(
    (row) => {
      const key =
        safeText(row.category);

      categoryMap.set(
        key,
        (categoryMap.get(key) || 0) +
          toNumber(row.amount)
      );
    }
  );

  const expenseCategories =
    Array.from(
      categoryMap.entries()
    )
      .map(
        ([category, total]) => ({
          category,
          total,
        })
      )
      .sort(
        (a, b) =>
          b.total - a.total
      );

  // ----------------------------------------------------------
  // Monthly chart data
  // ----------------------------------------------------------

  const chart = [
    {
      label: "Income",
      value: totalIncome,
    },
    {
      label: "Expenses",
      value: totalExpenses,
    },
    {
      label: "EMI / Loan",
      value:
        totalLoanEmi +
        totalLoanRepayment,
    },
    {
      label: "Borrow Repayment",
      value:
        totalBorrowRepayment,
    },
  ];

  return {
    user: userResult.rows[0],

    overview:
      overviewResult.rows[0] || {
        total_business: 0,
        total_works: 0,
        business_payment: 0,
        work_payment: 0,
      },

    month,

    summary: {
      total_income: totalIncome,
      total_expenses: totalExpenses,
      total_emi: totalLoanEmi,
      total_loan_repayment:
        totalLoanRepayment,
      total_borrow_repayment:
        totalBorrowRepayment,
      total_outgoing: totalOutgoing,
      net,
      savings: Math.max(0, net),
      loss: Math.max(0, -net),
      pending: totalPending,
      overdue: totalOverdue,
      lost: totalLost,
      status:
        statusFromTotals(
          totalIncome,
          totalOutgoing
        ),
    },

    chart,

    expenseCategories,

    weekly,

    payments:
      paymentsResult.rows.map(
        (row) => ({
          ...row,
          amount:
            toNumber(row.amount),
        })
      ),

    expenses:
      expensesResult.rows.map(
        (row) => ({
          ...row,
          amount:
            toNumber(row.amount),
        })
      ),

    loans:
      loansResult.rows.map(
        (row) => ({
          ...row,
          amount:
            toNumber(row.amount),
          emi:
            toNumber(row.emi),
        })
      ),

    repayments:
      repaymentsResult.rows.map(
        (row) => ({
          ...row,
          amount:
            toNumber(row.amount),
        })
      ),
  };
};

// ============================================================
// PDF HELPERS
// ============================================================

const PDF_MARGIN = 42;

const drawPdfTitle = (
  doc,
  title,
  subtitle
) => {
  doc
    .fontSize(22)
    .font("Helvetica-Bold")
    .text(title, {
      align: "left",
    });

  doc
    .moveDown(0.3)
    .fontSize(10)
    .font("Helvetica")
    .text(subtitle);

  doc.moveDown(1);
};

const drawPdfSection = (
  doc,
  title
) => {
  // Prevent section title from being stranded
  // at the bottom of a page.
  if (
    doc.y >
    doc.page.height - 100
  ) {
    doc.addPage();
  }

  doc
    .fontSize(14)
    .font("Helvetica-Bold")
    .text(title);

  doc.moveDown(0.4);
};

const drawPdfLine = (
  doc,
  label,
  value
) => {
  const y = doc.y;

  doc
    .fontSize(9)
    .font("Helvetica-Bold")
    .text(
      `${safeText(label)}:`,
      PDF_MARGIN,
      y,
      {
        width: 180,
        continued: true,
      }
    );

  doc
    .font("Helvetica")
    .text(
      ` ${safeText(value)}`,
      {
        width:
          doc.page.width -
          PDF_MARGIN * 2 -
          180,
      }
    );

  doc.moveDown(0.15);
};

const drawPdfSummary = (
  doc,
  data
) => {
  drawPdfSection(
    doc,
    "Monthly Financial Summary"
  );

  const rows = [
    [
      "Total Income",
      money(
        data.summary.total_income
      ),
    ],
    [
      "Total Expenses",
      money(
        data.summary.total_expenses
      ),
    ],
    [
      "EMI / Loan",
      money(
        data.summary.total_emi +
        data.summary.total_loan_repayment
      ),
    ],
    [
      "Borrow Repayment",
      money(
        data.summary.total_borrow_repayment
      ),
    ],
    [
      "Total Outgoing",
      money(
        data.summary.total_outgoing
      ),
    ],
    [
      "Net",
      money(data.summary.net),
    ],
    [
      "Savings",
      money(data.summary.savings),
    ],
    [
      "Loss",
      money(data.summary.loss),
    ],
    [
      "Status",
      data.summary.status,
    ],
  ];

  rows.forEach(
    ([label, value]) =>
      drawPdfLine(
        doc,
        label,
        value
      )
  );

  doc.moveDown(0.5);

  // Simple pie-chart-style proportional bars.
  // This is intentionally rendered as vector PDF content
  // so the export does not depend on external images.
  drawPdfSection(
    doc,
    "Financial Distribution"
  );

  const chartTotal =
    data.chart.reduce(
      (sum, item) =>
        sum + Number(item.value || 0),
      0
    );

  data.chart.forEach(
    (item) => {
      const percentage =
        chartTotal > 0
          ? (
              (item.value /
                chartTotal) *
              100
            )
          : 0;

      doc
        .fontSize(8)
        .font("Helvetica-Bold")
        .text(
          `${item.label} — ${money(
            item.value
          )} (${percentage.toFixed(1)}%)`
        );

      const barWidth =
        Math.min(
          460,
          Math.max(
            2,
            460 *
              (percentage / 100)
          )
        );

      const y = doc.y;

      doc
        .rect(
          PDF_MARGIN,
          y,
          barWidth,
          8
        )
        .fillOpacity(0.18)
        .fill()
        .fillOpacity(1);

      doc.moveDown(0.5);
    }
  );
};

const drawPdfTable = (
  doc,
  title,
  columns,
  rows
) => {
  drawPdfSection(
    doc,
    title
  );

  const pageWidth =
    doc.page.width -
    PDF_MARGIN * 2;

  const columnWidth =
    pageWidth /
    columns.length;

  const rowHeight = 24;

  const drawHeader = () => {
    const y = doc.y;

    doc
      .rect(
        PDF_MARGIN,
        y,
        pageWidth,
        rowHeight
      )
      .fillOpacity(0.08)
      .fill()
      .fillOpacity(1);

    columns.forEach(
      (column, index) => {
        doc
          .fontSize(7.5)
          .font("Helvetica-Bold")
          .text(
            safeText(column),
            PDF_MARGIN +
              index *
                columnWidth +
              4,
            y + 7,
            {
              width:
                columnWidth - 8,
              height: 14,
              ellipsis: false,
            }
          );
      }
    );

    doc.y =
      y + rowHeight;
  };

  drawHeader();

  rows.forEach(
    (row, rowIndex) => {
      if (
        doc.y >
        doc.page.height -
          PDF_MARGIN -
          rowHeight
      ) {
        doc.addPage();
        drawHeader();
      }

      const y = doc.y;

      if (rowIndex % 2 === 0) {
        doc
          .rect(
            PDF_MARGIN,
            y,
            pageWidth,
            rowHeight
          )
          .fillOpacity(0.025)
          .fill()
          .fillOpacity(1);
      }

      columns.forEach(
        (_, index) => {
          const value =
            row[index];

          doc
            .fontSize(7.2)
            .font("Helvetica")
            .text(
              safeText(value),
              PDF_MARGIN +
                index *
                  columnWidth +
                4,
              y + 7,
              {
                width:
                  columnWidth - 8,
                height: 14,
                ellipsis: false,
              }
            );
        }
      );

      doc.y =
        y + rowHeight;
    }
  );

  doc.moveDown(0.8);
};

// ============================================================
// BUILD PDF
// ============================================================

const buildPdf = (
  data,
  res,
  filename
) => {
  const doc =
    new PDFDocument({
      size: "A4",
      margins: {
        top: PDF_MARGIN,
        bottom: PDF_MARGIN,
        left: PDF_MARGIN,
        right: PDF_MARGIN,
      },
      bufferPages: true,
      info: {
        Title:
          `Personal Financial Report - ${data.month}`,
        Author:
          safeText(
            data.user.full_name
          ),
        Subject:
          "Personal Dashboard Export",
      },
    });

  res.setHeader(
    "Content-Type",
    "application/pdf"
  );

  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename}"`
  );

  doc.pipe(res);

  // ----------------------------------------------------------
  // Header
  // ----------------------------------------------------------

  drawPdfTitle(
    doc,
    "Personal Financial Report",
    `${safeText(
      data.user.full_name
    )} • ${data.month}`
  );

  drawPdfLine(
    doc,
    "Profession",
    data.user.profession
  );

  drawPdfLine(
    doc,
    "Email",
    data.user.email_address
  );

  drawPdfLine(
    doc,
    "Phone",
    data.user.phone1
  );

  drawPdfLine(
    doc,
    "Location",
    [
      data.user.city,
      data.user.taluka,
      data.user.district,
      data.user.state,
      data.user.pincode,
    ]
      .filter(Boolean)
      .join(", ")
  );

  doc.moveDown(0.5);

  drawPdfSummary(
    doc,
    data
  );

  // ----------------------------------------------------------
  // Overview
  // ----------------------------------------------------------

  drawPdfSection(
    doc,
    "Overview"
  );

  drawPdfLine(
    doc,
    "Total Business",
    data.overview.total_business
  );

  drawPdfLine(
    doc,
    "Total Works",
    data.overview.total_works
  );

  drawPdfLine(
    doc,
    "Business Payment",
    money(
      data.overview.business_payment
    )
  );

  drawPdfLine(
    doc,
    "Work Payment",
    money(
      data.overview.work_payment
    )
  );

  // ----------------------------------------------------------
  // Expense categories
  // ----------------------------------------------------------

  drawPdfTable(
    doc,
    "Expense Categories",
    [
      "Category",
      "Total",
    ],
    data.expenseCategories.map(
      (row) => [
        row.category,
        money(row.total),
      ]
    )
  );

  // ----------------------------------------------------------
  // Weekly performance
  // ----------------------------------------------------------

  drawPdfTable(
    doc,
    "Weekly Performance",
    [
      "Week",
      "Income",
      "Expenses",
      "Loan/EMI",
      "Borrow",
      "Outgoing",
      "Net",
      "Status",
    ],
    data.weekly.map(
      (row) => [
        `Week ${row.week}`,
        money(row.income),
        money(row.expenses),
        money(
          row.loan_emi +
          row.loan_repayment
        ),
        money(
          row.borrow_repayment
        ),
        money(row.outgoing),
        money(row.net),
        row.status,
      ]
    )
  );

  // ----------------------------------------------------------
  // Payments
  // ----------------------------------------------------------

  drawPdfTable(
    doc,
    "Payments",
    [
      "Person",
      "Category",
      "Amount",
      "Payment Date",
      "Received",
      "Status",
    ],
    data.payments.map(
      (row) => [
        row.person_name,
        row.category,
        money(row.amount),
        row.payment_date,
        row.received_at
          ? String(
              row.received_at
            ).slice(0, 10)
          : "-",
        row.status,
      ]
    )
  );

  // ----------------------------------------------------------
  // Expenses
  // ----------------------------------------------------------

  drawPdfTable(
    doc,
    "Expenses",
    [
      "Category",
      "Amount",
      "Date",
      "Notes",
    ],
    data.expenses.map(
      (row) => [
        row.category,
        money(row.amount),
        row.expense_date,
        row.notes || "-",
      ]
    )
  );

  // ----------------------------------------------------------
  // Loans / Borrow
  // ----------------------------------------------------------

  drawPdfTable(
    doc,
    "Loans & Borrow",
    [
      "Name",
      "Type",
      "Amount",
      "EMI",
      "Start",
      "Due",
      "Status",
    ],
    data.loans.map(
      (row) => [
        row.name,
        row.type,
        money(row.amount),
        money(row.emi),
        row.start_date,
        row.type === "Loan"
          ? row.end_date
          : row.return_date,
        row.status,
      ]
    )
  );

  // ----------------------------------------------------------
  // Repayments
  // ----------------------------------------------------------

  drawPdfTable(
    doc,
    "Loan / Borrow Repayments",
    [
      "Loan ID",
      "Amount",
      "Date",
      "Type",
      "Notes",
    ],
    data.repayments.map(
      (row) => [
        row.loan_id,
        money(row.amount),
        row.payment_date,
        row.payment_type,
        row.notes || "-",
      ]
    )
  );

  // ----------------------------------------------------------
  // Footer on every page
  // ----------------------------------------------------------

  const range =
    doc.bufferedPageRange();

  for (
    let index = range.start;
    index <
    range.start + range.count;
    index++
  ) {
    doc.switchToPage(index);

    const footerY =
      doc.page.height -
      25;

    doc
      .fontSize(7)
      .font("Helvetica")
      .text(
        `© ${new Date().getFullYear()} Personal Dashboard • Page ${index + 1} of ${range.count}`,
        PDF_MARGIN,
        footerY,
        {
          width:
            doc.page.width -
            PDF_MARGIN * 2,
          align: "center",
        }
      );
  }

  doc.end();
};

// ============================================================
// EXCEL HELPERS
// ============================================================

const styleWorksheet = (
  worksheet
) => {
  worksheet.views = [
    {
      state: "frozen",
      ySplit: 1,
    },
  ];

  worksheet.autoFilter = {
    from: "A1",
    to: worksheet.getCell(
      1,
      Math.max(
        1,
        worksheet.columnCount
      )
    ).address,
  };

  worksheet.eachRow(
    (row, rowNumber) => {
      row.eachCell(
        (cell) => {
          cell.alignment = {
            vertical: "middle",
            wrapText: true,
          };

          if (
            rowNumber === 1
          ) {
            cell.font = {
              bold: true,
              size: 11,
            };
          }
        }
      );

      row.height =
        rowNumber === 1
          ? 24
          : 20;
    }
  );

  worksheet.columns.forEach(
    (column) => {
      let maxLength = 10;

      column.eachCell(
        {
          includeEmpty: false,
        },
        (cell) => {
          const length =
            String(
              cell.value ?? ""
            ).length;

          maxLength =
            Math.max(
              maxLength,
              Math.min(
                length + 2,
                45
              )
            );
        }
      );

      column.width =
        Math.min(
          Math.max(
            maxLength,
            12
          ),
          45
        );
    }
  );
};

const addWorksheet = (
  workbook,
  name,
  headers,
  rows
) => {
  const worksheet =
    workbook.addWorksheet(
      name
    );

  worksheet.addRow(
    headers
  );

  rows.forEach(
    (row) =>
      worksheet.addRow(
        row
      )
  );

  styleWorksheet(
    worksheet
  );

  return worksheet;
};

// ============================================================
// BUILD EXCEL
// ============================================================

const buildExcel = async (
  data,
  res,
  filename
) => {
  const workbook =
    new ExcelJS.Workbook();

  workbook.creator =
    "Personal Dashboard";

  workbook.created =
    new Date();

  workbook.modified =
    new Date();

  workbook.properties = {
    title:
      `Personal Financial Report - ${data.month}`,
    subject:
      "Personal Dashboard Export",
    company:
      "Personal Dashboard",
  };

  // ----------------------------------------------------------
  // Summary
  // ----------------------------------------------------------

  addWorksheet(
    workbook,
    "Summary",
    [
      "Metric",
      "Value",
    ],
    [
      [
        "Month",
        data.month,
      ],
      [
        "Total Income",
        data.summary.total_income,
      ],
      [
        "Total Expenses",
        data.summary.total_expenses,
      ],
      [
        "EMI",
        data.summary.total_emi,
      ],
      [
        "Loan Repayment",
        data.summary.total_loan_repayment,
      ],
      [
        "Borrow Repayment",
        data.summary.total_borrow_repayment,
      ],
      [
        "Total Outgoing",
        data.summary.total_outgoing,
      ],
      [
        "Net",
        data.summary.net,
      ],
      [
        "Savings",
        data.summary.savings,
      ],
      [
        "Loss",
        data.summary.loss,
      ],
      [
        "Pending",
        data.summary.pending,
      ],
      [
        "Overdue",
        data.summary.overdue,
      ],
      [
        "Lost",
        data.summary.lost,
      ],
      [
        "Status",
        data.summary.status,
      ],
    ]
  );

  // ----------------------------------------------------------
  // Pie chart data
  // ----------------------------------------------------------

  addWorksheet(
    workbook,
    "Chart Data",
    [
      "Category",
      "Amount",
    ],
    data.chart.map(
      (row) => [
        row.label,
        row.value,
      ]
    )
  );

  // ----------------------------------------------------------
  // Overview
  // ----------------------------------------------------------

  addWorksheet(
    workbook,
    "Overview",
    [
      "Metric",
      "Value",
    ],
    [
      [
        "Total Business",
        data.overview.total_business,
      ],
      [
        "Total Works",
        data.overview.total_works,
      ],
      [
        "Business Payment",
        toNumber(
          data.overview.business_payment
        ),
      ],
      [
        "Work Payment",
        toNumber(
          data.overview.work_payment
        ),
      ],
    ]
  );

  // ----------------------------------------------------------
  // Weekly
  // ----------------------------------------------------------

  addWorksheet(
    workbook,
    "Weekly Performance",
    [
      "Week",
      "Income",
      "Expenses",
      "Loan EMI",
      "Loan Repayment",
      "Borrow Repayment",
      "Pending",
      "Overdue",
      "Lost",
      "Outgoing",
      "Net",
      "Status",
    ],
    data.weekly.map(
      (row) => [
        `Week ${row.week}`,
        row.income,
        row.expenses,
        row.loan_emi,
        row.loan_repayment,
        row.borrow_repayment,
        row.pending,
        row.overdue,
        row.lost,
        row.outgoing,
        row.net,
        row.status,
      ]
    )
  );

  // ----------------------------------------------------------
  // Expense categories
  // ----------------------------------------------------------

  addWorksheet(
    workbook,
    "Expense Categories",
    [
      "Category",
      "Total",
    ],
    data.expenseCategories.map(
      (row) => [
        row.category,
        row.total,
      ]
    )
  );

  // ----------------------------------------------------------
  // Expenses
  // ----------------------------------------------------------

  addWorksheet(
    workbook,
    "Expenses",
    [
      "ID",
      "Category",
      "Amount",
      "Date",
      "Notes",
    ],
    data.expenses.map(
      (row) => [
        row.id,
        row.category,
        row.amount,
        row.expense_date,
        row.notes || "",
      ]
    )
  );

  // ----------------------------------------------------------
  // Payments
  // ----------------------------------------------------------

  addWorksheet(
    workbook,
    "Payments",
    [
      "ID",
      "Person",
      "Amount",
      "Category",
      "Payment Date",
      "Received At",
      "Status",
      "Notes",
    ],
    data.payments.map(
      (row) => [
        row.id,
        row.person_name,
        row.amount,
        row.category,
        row.payment_date,
        row.received_at
          ? String(
              row.received_at
            ).slice(0, 19)
          : "",
        row.status,
        row.notes || "",
      ]
    )
  );

  // ----------------------------------------------------------
  // Loans / Borrow
  // ----------------------------------------------------------

  addWorksheet(
    workbook,
    "Loans Borrow",
    [
      "ID",
      "Name",
      "Type",
      "Amount",
      "EMI",
      "Start Date",
      "End Date",
      "Return Date",
      "Status",
      "Notes",
    ],
    data.loans.map(
      (row) => [
        row.id,
        row.name,
        row.type,
        row.amount,
        row.emi,
        row.start_date,
        row.end_date || "",
        row.return_date || "",
        row.status,
        row.notes || "",
      ]
    )
  );

  // ----------------------------------------------------------
  // Repayments
  // ----------------------------------------------------------

  addWorksheet(
    workbook,
    "Repayments",
    [
      "ID",
      "Loan ID",
      "Amount",
      "Payment Date",
      "Payment Type",
      "Notes",
    ],
    data.repayments.map(
      (row) => [
        row.id,
        row.loan_id,
        row.amount,
        row.payment_date,
        row.payment_type,
        row.notes || "",
      ]
    )
  );

  // ----------------------------------------------------------
  // User details
  // ----------------------------------------------------------

  addWorksheet(
    workbook,
    "User Details",
    [
      "Field",
      "Value",
    ],
    [
      [
        "Name",
        data.user.full_name,
      ],
      [
        "Profession",
        data.user.profession,
      ],
      [
        "Username",
        data.user.username,
      ],
      [
        "Email",
        data.user.email_address,
      ],
      [
        "Phone 1",
        data.user.phone1,
      ],
      [
        "Phone 2",
        data.user.phone2,
      ],
      [
        "City",
        data.user.city,
      ],
      [
        "Taluka",
        data.user.taluka,
      ],
      [
        "District",
        data.user.district,
      ],
      [
        "State",
        data.user.state,
      ],
      [
        "Pincode",
        data.user.pincode,
      ],
    ]
  );

  // ----------------------------------------------------------
  // Professional number format
  // ----------------------------------------------------------

  workbook.worksheets.forEach(
    (worksheet) => {
      worksheet.eachRow(
        (row) => {
          row.eachCell(
            (cell) => {
              if (
                typeof cell.value ===
                "number"
              ) {
                cell.numFmt =
                  '₹#,##0.00';
              }
            }
          );
        }
      );
    }
  );

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );

  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename}"`
  );

  await workbook.xlsx.write(
    res
  );

  res.end();
};

// ============================================================
// BUILD TEXT
// ============================================================

const buildText = (
  data
) => {
  const lines = [];

  const add = (text = "") =>
    lines.push(text);

  const section = (
    title
  ) => {
    add("");
    add("=".repeat(72));
    add(title);
    add("=".repeat(72));
  };

  add(
    "PERSONAL FINANCIAL REPORT"
  );

  add(
    `Name    : ${safeText(
      data.user.full_name
    )}`
  );

  add(
    `Month   : ${data.month}`
  );

  add(
    `Status  : ${data.summary.status}`
  );

  section(
    "MONTHLY SUMMARY"
  );

  add(
    `Total Income        : ${money(
      data.summary.total_income
    )}`
  );

  add(
    `Total Expenses      : ${money(
      data.summary.total_expenses
    )}`
  );

  add(
    `EMI                 : ${money(
      data.summary.total_emi
    )}`
  );

  add(
    `Loan Repayment      : ${money(
      data.summary.total_loan_repayment
    )}`
  );

  add(
    `Borrow Repayment    : ${money(
      data.summary.total_borrow_repayment
    )}`
  );

  add(
    `Total Outgoing      : ${money(
      data.summary.total_outgoing
    )}`
  );

  add(
    `Net                 : ${money(
      data.summary.net
    )}`
  );

  add(
    `Savings             : ${money(
      data.summary.savings
    )}`
  );

  add(
    `Loss                : ${money(
      data.summary.loss
    )}`
  );

  add(
    `Pending             : ${money(
      data.summary.pending
    )}`
  );

  add(
    `Overdue             : ${money(
      data.summary.overdue
    )}`
  );

  add(
    `Lost                : ${money(
      data.summary.lost
    )}`
  );

  section(
    "OVERVIEW"
  );

  add(
    `Total Business      : ${safeText(
      data.overview.total_business
    )}`
  );

  add(
    `Total Works         : ${safeText(
      data.overview.total_works
    )}`
  );

  add(
    `Business Payment    : ${money(
      data.overview.business_payment
    )}`
  );

  add(
    `Work Payment        : ${money(
      data.overview.work_payment
    )}`
  );

  section(
    "WEEKLY PERFORMANCE"
  );

  data.weekly.forEach(
    (row) => {
      add(
        `Week ${row.week} | Income: ${money(
          row.income
        )} | Expense: ${money(
          row.expenses
        )} | Loan/EMI: ${money(
          row.loan_emi +
          row.loan_repayment
        )} | Borrow: ${money(
          row.borrow_repayment
        )} | Net: ${money(
          row.net
        )} | ${row.status}`
      );
    }
  );

  section(
    "EXPENSE CATEGORIES"
  );

  data.expenseCategories.forEach(
    (row) => {
      add(
        `${row.category}: ${money(
          row.total
        )}`
      );
    }
  );

  section(
    "PAYMENTS"
  );

  data.payments.forEach(
    (row) => {
      add(
        `${row.person_name} | ${row.category} | ${money(
          row.amount
        )} | ${row.payment_date} | ${row.status}`
      );
    }
  );

  section(
    "EXPENSES"
  );

  data.expenses.forEach(
    (row) => {
      add(
        `${row.category} | ${money(
          row.amount
        )} | ${row.expense_date} | ${safeText(
          row.notes
        )}`
      );
    }
  );

  section(
    "LOANS & BORROW"
  );

  data.loans.forEach(
    (row) => {
      const due =
        row.type === "Loan"
          ? row.end_date
          : row.return_date;

      add(
        `${row.name} | ${row.type} | ${money(
          row.amount
        )} | EMI: ${money(
          row.emi
        )} | Due: ${safeText(
          due
        )} | ${row.status}`
      );
    }
  );

  section(
    "REPAYMENTS"
  );

  data.repayments.forEach(
    (row) => {
      add(
        `Loan ID ${row.loan_id} | ${money(
          row.amount
        )} | ${row.payment_date} | ${row.payment_type} | ${safeText(
          row.notes
        )}`
      );
    }
  );

  add("");
  add(
    `Generated on: ${new Date().toLocaleString(
      "en-IN"
    )}`
  );

  add(
    "Personal Dashboard Export"
  );

  return lines.join("\n");
};

// ============================================================
// 1. EXPORT PDF
// GET /api/export-details/pdf?month=2026-08
// ============================================================

router.get(
  "/pdf",
  authenticate,
  async (req, res) => {
    try {
      const month =
        req.query.month ||
        getCurrentMonth();

      const data =
        await getExportData(
          req.userId,
          month
        );

      const safeMonth =
        month.replace(
          /[^0-9-]/g,
          ""
        );

      buildPdf(
        data,
        res,
        `Personal_Report_${safeMonth}.pdf`
      );
    } catch (error) {
      console.error(
        "❌ PDF export error:",
        error
      );

      if (!res.headersSent) {
        return res.status(500).json({
          success: false,
          message:
            "Failed to generate PDF",
          error: error.message,
        });
      }

      res.end();
    }
  }
);

// ============================================================
// 2. EXPORT EXCEL
// GET /api/export-details/excel?month=2026-08
//
// Excel contains separate sheets so no long text is hidden
// inside one overloaded sheet.
// ============================================================

router.get(
  "/excel",
  authenticate,
  async (req, res) => {
    try {
      const month =
        req.query.month ||
        getCurrentMonth();

      const data =
        await getExportData(
          req.userId,
          month
        );

      const safeMonth =
        month.replace(
          /[^0-9-]/g,
          ""
        );

      await buildExcel(
        data,
        res,
        `Personal_Report_${safeMonth}.xlsx`
      );
    } catch (error) {
      console.error(
        "❌ Excel export error:",
        error
      );

      if (!res.headersSent) {
        return res.status(500).json({
          success: false,
          message:
            "Failed to generate Excel",
          error: error.message,
        });
      }

      res.end();
    }
  }
);

// ============================================================
// 3. EXPORT TEXT
// GET /api/export-details/text?month=2026-08
// ============================================================

router.get(
  "/text",
  authenticate,
  async (req, res) => {
    try {
      const month =
        req.query.month ||
        getCurrentMonth();

      const data =
        await getExportData(
          req.userId,
          month
        );

      const text =
        buildText(data);

      const safeMonth =
        month.replace(
          /[^0-9-]/g,
          ""
        );

      res.setHeader(
        "Content-Type",
        "text/plain; charset=utf-8"
      );

      res.setHeader(
        "Content-Disposition",
        `attachment; filename="Personal_Report_${safeMonth}.txt"`
      );

      return res.send(text);
    } catch (error) {
      console.error(
        "❌ Text export error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Failed to generate text report",
        error: error.message,
      });
    }
  }
);

// ============================================================
// 4. EXPORT JSON
// GET /api/export-details/json?month=2026-08
//
// Useful for frontend preview before downloading.
// ============================================================

router.get(
  "/json",
  authenticate,
  async (req, res) => {
    try {
      const month =
        req.query.month ||
        getCurrentMonth();

      const data =
        await getExportData(
          req.userId,
          month
        );

      return res.json({
        success: true,
        data,
      });
    } catch (error) {
      console.error(
        "❌ JSON export error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Failed to prepare export data",
        error: error.message,
      });
    }
  }
);

// ============================================================
// 5. EXPORT OVERVIEW ONLY PDF
// GET /api/export-details/overview/pdf?month=2026-08
// ============================================================

router.get(
  "/overview/pdf",
  authenticate,
  async (req, res) => {
    try {
      const month =
        req.query.month ||
        getCurrentMonth();

      const data =
        await getExportData(
          req.userId,
          month
        );

      const doc =
        new PDFDocument({
          size: "A4",
          margins: {
            top: PDF_MARGIN,
            bottom: PDF_MARGIN,
            left: PDF_MARGIN,
            right: PDF_MARGIN,
          },
          bufferPages: true,
          info: {
            Title:
              `Overview Report - ${month}`,
            Author:
              safeText(
                data.user.full_name
              ),
          },
        });

      res.setHeader(
        "Content-Type",
        "application/pdf"
      );

      res.setHeader(
        "Content-Disposition",
        `attachment; filename="Overview_Report_${month}.pdf"`
      );

      doc.pipe(res);

      drawPdfTitle(
        doc,
        "Overview Report",
        `${safeText(
          data.user.full_name
        )} • ${month}`
      );

      drawPdfSection(
        doc,
        "Overview Details"
      );

      drawPdfLine(
        doc,
        "Total Business",
        data.overview.total_business
      );

      drawPdfLine(
        doc,
        "Total Works",
        data.overview.total_works
      );

      drawPdfLine(
        doc,
        "Business Payment",
        money(
          data.overview.business_payment
        )
      );

      drawPdfLine(
        doc,
        "Work Payment",
        money(
          data.overview.work_payment
        )
      );

      drawPdfSection(
        doc,
        "Selected Month Financial Result"
      );

      drawPdfLine(
        doc,
        "Income",
        money(
          data.summary.total_income
        )
      );

      drawPdfLine(
        doc,
        "Expense",
        money(
          data.summary.total_expenses
        )
      );

      drawPdfLine(
        doc,
        "Total Outgoing",
        money(
          data.summary.total_outgoing
        )
      );

      drawPdfLine(
        doc,
        "Net",
        money(data.summary.net)
      );

      drawPdfLine(
        doc,
        "Status",
        data.summary.status
      );

      drawPdfSection(
        doc,
        "Upcoming / Outstanding"
      );

      drawPdfLine(
        doc,
        "Pending Payments",
        money(
          data.summary.pending
        )
      );

      drawPdfLine(
        doc,
        "Overdue Payments",
        money(
          data.summary.overdue
        )
      );

      drawPdfLine(
        doc,
        "Lost Payments",
        money(
          data.summary.lost
        )
      );

      const range =
        doc.bufferedPageRange();

      for (
        let index = range.start;
        index <
        range.start + range.count;
        index++
      ) {
        doc.switchToPage(
          index
        );

        doc
          .fontSize(7)
          .font("Helvetica")
          .text(
            `© ${new Date().getFullYear()} Personal Dashboard • Page ${index + 1} of ${range.count}`,
            PDF_MARGIN,
            doc.page.height - 25,
            {
              width:
                doc.page.width -
                PDF_MARGIN * 2,
              align: "center",
            }
          );
      }

      doc.end();
    } catch (error) {
      console.error(
        "❌ Overview PDF export error:",
        error
      );

      if (!res.headersSent) {
        return res.status(500).json({
          success: false,
          message:
            "Failed to generate overview PDF",
          error: error.message,
        });
      }

      res.end();
    }
  }
);

// ============================================================
// 6. EXPORT OVERVIEW ONLY EXCEL
// GET /api/export-details/overview/excel
// ============================================================

router.get(
  "/overview/excel",
  authenticate,
  async (req, res) => {
    try {
      const month =
        req.query.month ||
        getCurrentMonth();

      const data =
        await getExportData(
          req.userId,
          month
        );

      const workbook =
        new ExcelJS.Workbook();

      const worksheet =
        workbook.addWorksheet(
          "Overview"
        );

      worksheet.addRows([
        [
          "Personal Dashboard Overview",
          "",
        ],
        [
          "Name",
          data.user.full_name,
        ],
        [
          "Month",
          month,
        ],
        [
          "Total Business",
          data.overview.total_business,
        ],
        [
          "Total Works",
          data.overview.total_works,
        ],
        [
          "Business Payment",
          toNumber(
            data.overview.business_payment
          ),
        ],
        [
          "Work Payment",
          toNumber(
            data.overview.work_payment
          ),
        ],
        [
          "Monthly Income",
          data.summary.total_income,
        ],
        [
          "Monthly Expense",
          data.summary.total_expenses,
        ],
        [
          "Total Outgoing",
          data.summary.total_outgoing,
        ],
        [
          "Net",
          data.summary.net,
        ],
        [
          "Savings",
          data.summary.savings,
        ],
        [
          "Loss",
          data.summary.loss,
        ],
        [
          "Status",
          data.summary.status,
        ],
      ]);

      worksheet.columns = [
        {
          width: 28,
        },
        {
          width: 30,
        },
      ];

      worksheet.eachRow(
        (row, rowNumber) => {
          row.eachCell(
            (cell) => {
              cell.alignment = {
                vertical:
                  "middle",
                wrapText: true,
              };

              if (
                rowNumber === 1
              ) {
                cell.font = {
                  bold: true,
                  size: 14,
                };
              }
            }
          );

          row.height =
            rowNumber === 1
              ? 28
              : 22;
        }
      );

      worksheet.eachRow(
        (row) => {
          row.eachCell(
            (cell) => {
              if (
                typeof cell.value ===
                "number"
              ) {
                cell.numFmt =
                  '₹#,##0.00';
              }
            }
          );
        }
      );

      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );

      res.setHeader(
        "Content-Disposition",
        `attachment; filename="Overview_Report_${month}.xlsx"`
      );

      await workbook.xlsx.write(
        res
      );

      res.end();
    } catch (error) {
      console.error(
        "❌ Overview Excel export error:",
        error
      );

      if (!res.headersSent) {
        return res.status(500).json({
          success: false,
          message:
            "Failed to generate overview Excel",
          error: error.message,
        });
      }

      res.end();
    }
  }
);

// ============================================================
// 7. EXPORT OVERVIEW ONLY TEXT
// GET /api/export-details/overview/text
// ============================================================

router.get(
  "/overview/text",
  authenticate,
  async (req, res) => {
    try {
      const month =
        req.query.month ||
        getCurrentMonth();

      const data =
        await getExportData(
          req.userId,
          month
        );

      const lines = [
        "PERSONAL DASHBOARD - OVERVIEW",
        "=".repeat(60),
        `Name: ${safeText(
          data.user.full_name
        )}`,
        `Month: ${month}`,
        "",
        "OVERVIEW",
        "-".repeat(60),
        `Total Business: ${safeText(
          data.overview.total_business
        )}`,
        `Total Works: ${safeText(
          data.overview.total_works
        )}`,
        `Business Payment: ${money(
          data.overview.business_payment
        )}`,
        `Work Payment: ${money(
          data.overview.work_payment
        )}`,
        "",
        "MONTHLY FINANCIAL RESULT",
        "-".repeat(60),
        `Income: ${money(
          data.summary.total_income
        )}`,
        `Expense: ${money(
          data.summary.total_expenses
        )}`,
        `Total Outgoing: ${money(
          data.summary.total_outgoing
        )}`,
        `Net: ${money(
          data.summary.net
        )}`,
        `Savings: ${money(
          data.summary.savings
        )}`,
        `Loss: ${money(
          data.summary.loss
        )}`,
        `Status: ${data.summary.status}`,
        "",
        "PAYMENT STATUS",
        "-".repeat(60),
        `Pending: ${money(
          data.summary.pending
        )}`,
        `Overdue: ${money(
          data.summary.overdue
        )}`,
        `Lost: ${money(
          data.summary.lost
        )}`,
        "",
        `Generated: ${new Date().toLocaleString(
          "en-IN"
        )}`,
      ];

      res.setHeader(
        "Content-Type",
        "text/plain; charset=utf-8"
      );

      res.setHeader(
        "Content-Disposition",
        `attachment; filename="Overview_Report_${month}.txt"`
      );

      return res.send(
        lines.join("\n")
      );
    } catch (error) {
      console.error(
        "❌ Overview text export error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Failed to generate overview text",
        error: error.message,
      });
    }
  }
);

// ============================================================
// EXPORT
// ============================================================

module.exports = router;