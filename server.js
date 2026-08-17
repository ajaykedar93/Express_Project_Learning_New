const express = require("express");
const cors = require("cors");
require("dotenv").config();

const db = require("./db");

// ================================
// API ROUTE IMPORTS
// ================================

// Authentication
// NOTE: Keep this import if authRoutes is already available
// in your project.
const authRoutes = require("./routes/auth");

// Personal Dashboard APIs
const personalUserRoutes = require("./routes/personal_user");
const overviewRoutes = require("./routes/overviewapi");
const expenseRoutes = require("./routes/expenseapi");
const loanBorrowRoutes = require("./routes/loanBorrowapi");
const paymentRoutes = require("./routes/paymentapi");
const performanceRoutes = require("./routes/performanceapi");
const summaryRoutes = require("./routes/summaryapi");
const exportDetailsRoutes = require("./routes/exportDetailsapi");

// =============================================
// NEW PERSONAL APIs
// =============================================

const personalLoansRoutes = require("./routes/personal_loans");
const personalTradingRoutes = require("./routes/personal_trading");
const personalTransactionsRoutes = require("./routes/personal_transactions");



const app = express();

// =============================================
// CORS
// =============================================

const allowedOrigins = [
    "http://localhost:5173",
    "http://localhost:3000",
    "https://react-learning-project-lime.vercel.app"
];

if (process.env.CLIENT_URL) {

    const clientUrl = process.env.CLIENT_URL
        .trim()
        .replace(/\/$/, "");

    if (
        clientUrl &&
        !allowedOrigins.includes(clientUrl)
    ) {
        allowedOrigins.push(clientUrl);
    }

}

app.use(
    cors({
        origin: function (origin, callback) {

            // Allow requests without Origin
            if (!origin) {
                return callback(null, true);
            }

            const cleanOrigin = origin
                .trim()
                .replace(/\/$/, "");

            if (allowedOrigins.includes(cleanOrigin)) {
                return callback(null, true);
            }

            console.log(
                "CORS blocked:",
                cleanOrigin
            );

            return callback(
                new Error("Not allowed by CORS")
            );
        },

        credentials: true,

        methods: [
            "GET",
            "POST",
            "PUT",
            "PATCH",
            "DELETE",
            "OPTIONS"
        ],

        allowedHeaders: [
            "Content-Type",
            "Authorization"
        ]
    })
);

// =============================================
// MIDDLEWARE
// =============================================

app.use(
    express.json({
        limit: "10mb"
    })
);

app.use(
    express.urlencoded({
        extended: true,
        limit: "10mb"
    })
);

// =============================================
// ROUTES
// =============================================

// Authentication
app.use(
    "/api/auth",
    authRoutes
);

// Personal Users
app.use(
    "/api/personal-users",
    personalUserRoutes
);

// ================================
// PERSONAL DASHBOARD API ENDPOINTS
// ================================

app.use(
    "/api/personal-user",
    personalUserRoutes
);

app.use(
    "/api/overview",
    overviewRoutes
);

app.use(
    "/api/expenses",
    expenseRoutes
);

app.use(
    "/api/loan-borrow",
    loanBorrowRoutes
);

app.use(
    "/api/payments",
    paymentRoutes
);

app.use(
    "/api/performance",
    performanceRoutes
);

app.use(
    "/api/summary",
    summaryRoutes
);

app.use(
    "/api/export-details",
    exportDetailsRoutes
);

// =============================================
// NEW PERSONAL API ENDPOINTS
// =============================================

// Personal Loans
app.use(
    "/api/personal-loans",
    personalLoansRoutes
);

// Personal Trading
app.use(
    "/api/personal-trading",
    personalTradingRoutes
);

// Personal Transactions
app.use(
    "/api/personal-transactions",
    personalTransactionsRoutes
);

// =============================================
// HEALTH CHECK
// =============================================

app.get(
    "/api/health",
    (req, res) => {

        res.status(200).json({
            success: true,
            message: "Server is running",
            timestamp: new Date().toISOString()
        });

    }
);

// =============================================
// 404 HANDLER
// =============================================

app.use(
    (req, res) => {

        res.status(404).json({
            success: false,
            message:
                `Route not found: ${req.method} ${req.path}`
        });

    }
);

// =============================================
// ERROR HANDLER
// =============================================

app.use(
    (err, req, res, next) => {

        console.error(
            "Server Error:",
            err.message
        );

        if (
            err.message ===
            "Not allowed by CORS"
        ) {

            return res.status(403).json({
                success: false,
                message:
                    "CORS origin not allowed"
            });

        }

        res.status(500).json({
            success: false,
            message:
                "Internal server error"
        });

    }
);

// =============================================
// START SERVER
// =============================================

const PORT =
    process.env.PORT || 5000;

app.listen(
    PORT,
    () => {
        console.log(
            `🚀 Server Running on port ${PORT}`
        );
    }
);