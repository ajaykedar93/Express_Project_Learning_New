const express = require("express");
const cors = require("cors");
require("dotenv").config();

const db = require("./db");

// Routes
const personalUserRoutes = require("./routes/personal_user");
const personalOverviewRoutes = require("./routes/personal_overview");
const personalTradingRoutes = require("./routes/personal_trading");




const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Personal User API
app.use("/api/personal-users", personalUserRoutes);

app.use("/api/personal-overview", personalOverviewRoutes);

app.use("/api/personal-trading", personalTradingRoutes);


// Health check
app.get("/api/health", (req, res) => {
  res.json({ success: true, message: "Server is running" });
});

// Server
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`🚀 Server Running on http://localhost:${PORT}`);
  console.log(`📊 Health: http://localhost:${PORT}/api/health`);
  console.log(`👤 Users: http://localhost:${PORT}/api/personal-users/all`);
});