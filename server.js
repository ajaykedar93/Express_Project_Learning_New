const express = require("express");
const cors = require("cors");
require("dotenv").config();

const db = require("./db");

// ============================================================
// API ROUTE IMPORTS
// ============================================================

const authRoutes = require("./routes/auth");

const personalUserRoutes = require("./routes/personal_user");
const overviewRoutes = require("./routes/overviewapi");
const expenseRoutes = require("./routes/expenseapi");
const loanBorrowRoutes = require("./routes/loanBorrowapi");
const paymentRoutes = require("./routes/paymentapi");


// To this:
const performanceRoutes = require("./routes/all_performance");

const exportDetailsRoutes = require("./routes/exportDetailsapi");

const personalTradingRoutes = require("./routes/personal_trading");

const app = express();

// ============================================================
// CORS
// ============================================================

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

const corsOptions = {
    origin: function (origin, callback) {
        // Allow requests without Origin header
        // such as Postman, curl and server-to-server requests.
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
        "Accept",
        "Content-Type",
        "Authorization",
        "X-User-Id",
        "X-User-ID",
        "X-Userid",
        "X-Auth-User-Id",
        "X-Auth-User-ID"
    ],

    exposedHeaders: [
        "Content-Disposition",
        "Content-Length"
    ],

    optionsSuccessStatus: 204
};

app.use(cors(corsOptions));

// IMPORTANT:
// Do NOT use app.options("*", ...).
// Express 5 / path-to-regexp rejects "*" and throws:
// PathError: Missing parameter name at index 1: *
// The cors middleware above already handles OPTIONS requests.


// ============================================================
// BODY MIDDLEWARE
// ============================================================

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


// ============================================================
// ROUTES
// ============================================================

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



app.use("/api/overview", overviewRoutes);
app.use("/api/expenses", expenseRoutes);
app.use("/api/loan-borrow", loanBorrowRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/performance", performanceRoutes);



app.use(
    "/api/export-details",
    exportDetailsRoutes
);

// Personal Trading
app.use(
    "/api/personal-trading",
    personalTradingRoutes
);


// ============================================================
// HEALTH CHECK
// ============================================================

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


// ============================================================
// EXPORT DETAILS HEALTH CHECK
// ============================================================

app.get(
    "/api/export-details-health",
    (req, res) => {
        res.status(200).json({
            success: true,
            service: "export-details",
            status: "mounted",
            timestamp: new Date().toISOString()
        });
    }
);


// ============================================================
// 404 HANDLER
// ============================================================

app.use(
    (req, res) => {
        res.status(404).json({
            success: false,
            message:
                `Route not found: ${req.method} ${req.path}`
        });
    }
);


// ============================================================
// ERROR HANDLER
// ============================================================

app.use(
    (err, req, res, next) => {
        console.error(
            "Server Error:",
            err
        );

        if (
            err &&
            err.message ===
            "Not allowed by CORS"
        ) {
            return res.status(403).json({
                success: false,
                message:
                    "CORS origin not allowed",
                origin:
                    req.headers.origin || null
            });
        }

        if (res.headersSent) {
            return next(err);
        }

        return res.status(500).json({
            success: false,
            message:
                "Internal server error"
        });
    }
);


// ============================================================
// START SERVER
// ============================================================

const PORT =
    Number(process.env.PORT) || 5000;

app.listen(
    PORT,
    () => {
        console.log(
            `🚀 Server Running on port ${PORT}`
        );

        console.log(
            "Allowed CORS origins:",
            allowedOrigins
        );
    }
);
