const express = require("express");
const cors = require("cors");
require("dotenv").config();

const db = require("./db");

// Routes
const personalUserRoutes = require("./routes/personal_user");
const personalOverviewRoutes = require("./routes/personal_overview");
const personalTradingRoutes = require("./routes/personal_trading");
const authRoutes = require("./routes/auth"); // ✅ Added Auth Routes
const personalTransactionsRoutes = require('./routes/personal_transactions');

const app = express();

// Middleware
app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:5173',
  credentials: true
}));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// =============================================
// ROUTES
// =============================================

// ✅ Auth Routes (Login, Register, Forgot, OTP)
app.use("/api/auth", authRoutes);

// Personal User API
app.use("/api/personal-users", personalUserRoutes);

// Personal Overview API
app.use("/api/personal-overview", personalOverviewRoutes);

// Personal Trading API
app.use("/api/personal-trading", personalTradingRoutes);

app.use('/api/personal-transactions', personalTransactionsRoutes);

// =============================================
// HEALTH CHECK
// =============================================
app.get("/api/health", (req, res) => {
  res.json({ 
    success: true, 
    message: "Server is running",
    timestamp: new Date().toISOString()
  });
});

// =============================================
// 404 HANDLER
// =============================================
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.path}`
  });
});

// =============================================
// ERROR HANDLER
// =============================================
app.use((err, req, res, next) => {
  console.error('❌ Server Error:', err.message);
  res.status(500).json({
    success: false,
    message: 'Internal server error',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// =============================================
// START SERVER
// =============================================
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`🚀 Server Running on http://localhost:${PORT}`);
  console.log(`📊 Health: http://localhost:${PORT}/api/health`);
  console.log(`👤 Users: http://localhost:${PORT}/api/personal-users/all`);
  console.log(`🔐 Auth: http://localhost:${PORT}/api/auth/login`);
  console.log(`📋 API Routes:`);
  console.log(`   POST   /api/auth/login`);
  console.log(`   POST   /api/auth/register`);
  console.log(`   POST   /api/auth/send-otp`);
  console.log(`   POST   /api/auth/verify-otp`);
  console.log(`   POST   /api/auth/forgot/send-otp`);
  console.log(`   POST   /api/auth/forgot/verify-otp`);
  console.log(`   POST   /api/auth/forgot/reset-password`);
  console.log(`   GET    /api/auth/profile/:id`);
});