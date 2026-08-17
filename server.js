const express = require("express");
const cors = require("cors");
require("dotenv").config();

const db = require("./db");

// ============================================================
// API ROUTE IMPORTS
// ============================================================

// Authentication
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

// Personal Trading
const personalTradingRoutes = require("./routes/personal_trading");

const app = express();

// ============================================================
// BASIC APP SETTINGS
// ============================================================

app.disable("x-powered-by");

// ============================================================
// CORS
// ============================================================

const defaultAllowedOrigins = [
    "http://localhost:5173",
    "http://localhost:3000",
    "https://react-learning-project-lime.vercel.app"
];

const allowedOrigins = [...defaultAllowedOrigins];

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

const cleanOrigin = (origin) => {
    if (!origin) return "";

    return String(origin)
        .trim()
        .replace(/\/$/, "");
};

const corsOptions = {
    origin: function (origin, callback) {
        // Requests without an Origin header:
        // Postman, curl, server-to-server, health checks, etc.
        if (!origin) {
            return callback(null, true);
        }

        const originValue = cleanOrigin(origin);

        if (allowedOrigins.includes(originValue)) {
            return callback(null, true);
        }

        console.log(
            "CORS blocked:",
            originValue
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

// Explicit OPTIONS handling.
// This is important for browser preflight requests when the frontend
// sends Authorization / X-User-Id headers.
app.options(
    "*",
    cors(corsOptions)
);

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
// REQUEST LOGGING
// ============================================================

app.use((req, res, next) => {
    const startedAt = Date.now();

    res.on("finish", () => {
        const duration = Date.now() - startedAt;

        console.log(
            `${req.method} ${req.originalUrl} -> ${res.statusCode} (${duration}ms)`
        );
    });

    next();
});

// ============================================================
// AUTHENTICATION
// ============================================================

app.use(
    "/api/auth",
    authRoutes
);

// ============================================================
// PERSONAL USERS
// ============================================================

app.use(
    "/api/personal-users",
    personalUserRoutes
);

app.use(
    "/api/personal-user",
    personalUserRoutes
);

// ============================================================
// PERSONAL DASHBOARD APIS
// ============================================================

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

// ============================================================
// PERSONAL TRADING
// ============================================================

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

// Export-details health check.
// This does NOT require authentication and is useful for checking
// whether the export router itself is mounted correctly.
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
                    cleanOrigin(req.headers.origin)
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