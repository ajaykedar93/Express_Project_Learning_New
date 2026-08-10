// personal_trading.js - CommonJS
const express = require("express");
const router = express.Router();

// =============================================
// DATABASE
// =============================================

let db;

try {
    db = require("../db.js");
    console.log("✅ Database module loaded for Personal Trading");
} catch (err) {
    console.error("❌ Failed to load db.js:", err.message);
    db = null;
}

// =============================================
// CREATE / MIGRATE TABLE
// =============================================

const createTable = async () => {
    if (!db) {
        console.error("❌ Database connection not available");
        return;
    }

    try {
        // Create table
        await db.query(`
            CREATE TABLE IF NOT EXISTS personal_trading (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL,
                date DATE NOT NULL,
                broker VARCHAR(100) NOT NULL,
                segment VARCHAR(100) NOT NULL,
                name VARCHAR(150) NOT NULL,
                type VARCHAR(10) NOT NULL
                    CHECK (type IN ('Buy', 'Sell')),
                quantity DECIMAL(20,8) NOT NULL DEFAULT 1,
                entry_price DECIMAL(20,8) NOT NULL DEFAULT 0,
                exit_price DECIMAL(20,8) NOT NULL DEFAULT 0,
                gross_profit_loss DECIMAL(20,8) NOT NULL DEFAULT 0,
                brokerage DECIMAL(20,8) NOT NULL DEFAULT 0,
                profit_loss DECIMAL(20,8) NOT NULL DEFAULT 0,
                status VARCHAR(20) DEFAULT 'Break-even',
                notes TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // =============================================
        // MIGRATE OLD TABLE
        // =============================================

        const columns = [
            {
                name: "gross_profit_loss",
                sql: `
                    ALTER TABLE personal_trading
                    ADD COLUMN IF NOT EXISTS gross_profit_loss
                    DECIMAL(20,8) NOT NULL DEFAULT 0
                `
            },
            {
                name: "brokerage",
                sql: `
                    ALTER TABLE personal_trading
                    ADD COLUMN IF NOT EXISTS brokerage
                    DECIMAL(20,8) NOT NULL DEFAULT 0
                `
            },
            {
                name: "status",
                sql: `
                    ALTER TABLE personal_trading
                    ADD COLUMN IF NOT EXISTS status
                    VARCHAR(20) DEFAULT 'Break-even'
                `
            }
        ];

        for (const column of columns) {
            try {
                await db.query(column.sql);
                console.log(`✅ Column ready: ${column.name}`);
            } catch (err) {
                console.error(
                    `❌ Migration error for ${column.name}:`,
                    err.message
                );
            }
        }

        // Change quantity from INTEGER to DECIMAL
        try {
            await db.query(`
                ALTER TABLE personal_trading
                ALTER COLUMN quantity TYPE DECIMAL(20,8)
                USING quantity::DECIMAL(20,8)
            `);

            console.log("✅ Quantity converted to DECIMAL");
        } catch (err) {
            // Safe to ignore if already correct
            console.log(
                "ℹ️ Quantity type migration:",
                err.message
            );
        }

        // Fill old gross P&L values
        try {
            await db.query(`
                UPDATE personal_trading
                SET gross_profit_loss = profit_loss
                WHERE gross_profit_loss = 0
                  AND profit_loss <> 0
            `);
        } catch (err) {
            console.error(
                "❌ Gross P&L migration error:",
                err.message
            );
        }

        // Recalculate old status
        try {
            await db.query(`
                UPDATE personal_trading
                SET status = CASE
                    WHEN profit_loss > 0 THEN 'Profit'
                    WHEN profit_loss < 0 THEN 'Loss'
                    ELSE 'Break-even'
                END
                WHERE status IS NULL
                   OR status = ''
            `);
        } catch (err) {
            console.error(
                "❌ Status migration error:",
                err.message
            );
        }

        console.log("✅ personal_trading table ready");
    } catch (err) {
        console.error(
            "❌ Table creation error:",
            err.message
        );
    }
};

createTable();

// =============================================
// HELPER FUNCTIONS
// =============================================

const toNumber = (value, fallback = 0) => {
    const number = Number(value);

    return Number.isFinite(number)
        ? number
        : fallback;
};

const calculateTrade = ({
    type,
    quantity,
    entry_price,
    exit_price,
    brokerage
}) => {
    const qty = toNumber(quantity, 0);
    const entry = toNumber(entry_price, 0);
    const exit = toNumber(exit_price, 0);
    const charges = toNumber(brokerage, 0);

    let grossProfitLoss = 0;

    // BUY:
    // Profit = (Exit - Entry) × Quantity
    //
    // SELL:
    // Profit = (Entry - Exit) × Quantity
    if (type === "Sell") {
        grossProfitLoss =
            (entry - exit) * qty;
    } else {
        grossProfitLoss =
            (exit - entry) * qty;
    }

    const netProfitLoss =
        grossProfitLoss - charges;

    let status = "Break-even";

    if (netProfitLoss > 0) {
        status = "Profit";
    } else if (netProfitLoss < 0) {
        status = "Loss";
    }

    return {
        quantity: qty,
        entry_price: entry,
        exit_price: exit,
        gross_profit_loss: grossProfitLoss,
        brokerage: charges,
        profit_loss: netProfitLoss,
        status
    };
};

// =============================================
// VALIDATION
// =============================================

const validateTrade = (body) => {
    const {
        user_id,
        date,
        broker,
        segment,
        name,
        type,
        quantity,
        entry_price,
        exit_price
    } = body;

    if (!user_id) {
        return "user_id is required";
    }

    if (!date) {
        return "Date is required";
    }

    if (!broker) {
        return "Broker is required";
    }

    if (!segment) {
        return "Segment is required";
    }

    if (!name) {
        return "Trade name is required";
    }

    if (!["Buy", "Sell"].includes(type)) {
        return "Type must be Buy or Sell";
    }

    const qty = Number(quantity);

    if (!Number.isFinite(qty) || qty <= 0) {
        return "Quantity must be greater than 0";
    }

    const entry = Number(entry_price);
    const exit = Number(exit_price);

    if (!Number.isFinite(entry) || entry < 0) {
        return "Invalid entry price";
    }

    if (!Number.isFinite(exit) || exit < 0) {
        return "Invalid exit price";
    }

    return null;
};

// =============================================
// 1. CREATE - ADD TRADE
// =============================================

router.post("/add", async (req, res) => {
    try {
        if (!db) {
            return res.status(500).json({
                success: false,
                message:
                    "Database connection not available"
            });
        }

        const {
            user_id,
            date,
            broker,
            segment,
            name,
            type,
            quantity,
            entry_price,
            exit_price,
            brokerage,
            notes
        } = req.body;

        const validationError =
            validateTrade(req.body);

        if (validationError) {
            return res.status(400).json({
                success: false,
                message: validationError
            });
        }

        const calculation = calculateTrade({
            type,
            quantity,
            entry_price,
            exit_price,
            brokerage
        });

        const result = await db.query(
            `
            INSERT INTO personal_trading (
                user_id,
                date,
                broker,
                segment,
                name,
                type,
                quantity,
                entry_price,
                exit_price,
                gross_profit_loss,
                brokerage,
                profit_loss,
                status,
                notes
            )
            VALUES (
                $1, $2, $3, $4, $5, $6,
                $7, $8, $9, $10, $11,
                $12, $13, $14
            )
            RETURNING *
            `,
            [
                user_id,
                date,
                broker,
                segment,
                name,
                type,
                calculation.quantity,
                calculation.entry_price,
                calculation.exit_price,
                calculation.gross_profit_loss,
                calculation.brokerage,
                calculation.profit_loss,
                calculation.status,
                notes || null
            ]
        );

        return res.status(201).json({
            success: true,
            message:
                "✅ Trade added successfully",
            data: result.rows[0]
        });
    } catch (err) {
        console.error(
            "❌ Add trade error:",
            err.message
        );

        return res.status(500).json({
            success: false,
            message: "Failed to add trade",
            error: err.message
        });
    }
});

// =============================================
// 2. UPDATE - TRADE
// =============================================

router.put("/update/:id", async (req, res) => {
    try {
        if (!db) {
            return res.status(500).json({
                success: false,
                message:
                    "Database connection not available"
            });
        }

        const { id } = req.params;

        const {
            date,
            broker,
            segment,
            name,
            type,
            quantity,
            entry_price,
            exit_price,
            brokerage,
            notes
        } = req.body;

        const validationError =
            validateTrade({
                user_id: 1,
                date,
                broker,
                segment,
                name,
                type,
                quantity,
                entry_price,
                exit_price
            });

        if (validationError) {
            return res.status(400).json({
                success: false,
                message: validationError
            });
        }

        // Check trade
        const existingTrade =
            await db.query(
                `
                SELECT *
                FROM personal_trading
                WHERE id = $1
                `,
                [id]
            );

        if (existingTrade.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Trade not found"
            });
        }

        const calculation =
            calculateTrade({
                type,
                quantity,
                entry_price,
                exit_price,
                brokerage
            });

        const result = await db.query(
            `
            UPDATE personal_trading
            SET
                date = $1,
                broker = $2,
                segment = $3,
                name = $4,
                type = $5,
                quantity = $6,
                entry_price = $7,
                exit_price = $8,
                gross_profit_loss = $9,
                brokerage = $10,
                profit_loss = $11,
                status = $12,
                notes = $13,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $14
            RETURNING *
            `,
            [
                date,
                broker,
                segment,
                name,
                type,
                calculation.quantity,
                calculation.entry_price,
                calculation.exit_price,
                calculation.gross_profit_loss,
                calculation.brokerage,
                calculation.profit_loss,
                calculation.status,
                notes || null,
                id
            ]
        );

        return res.json({
            success: true,
            message:
                "✅ Trade updated successfully",
            data: result.rows[0]
        });
    } catch (err) {
        console.error(
            "❌ Update trade error:",
            err.message
        );

        return res.status(500).json({
            success: false,
            message: "Failed to update trade",
            error: err.message
        });
    }
});

// =============================================
// 3. DELETE - TRADE
// =============================================

router.delete("/delete/:id", async (req, res) => {
    try {
        if (!db) {
            return res.status(500).json({
                success: false,
                message:
                    "Database connection not available"
            });
        }

        const { id } = req.params;

        const existingTrade =
            await db.query(
                `
                SELECT *
                FROM personal_trading
                WHERE id = $1
                `,
                [id]
            );

        if (existingTrade.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Trade not found"
            });
        }

        await db.query(
            `
            DELETE FROM personal_trading
            WHERE id = $1
            `,
            [id]
        );

        return res.json({
            success: true,
            message:
                "✅ Trade deleted successfully",
            deletedId: Number(id)
        });
    } catch (err) {
        console.error(
            "❌ Delete trade error:",
            err.message
        );

        return res.status(500).json({
            success: false,
            message: "Failed to delete trade",
            error: err.message
        });
    }
});

// =============================================
// 4. GET - ALL TRADES
// =============================================

router.get("/all", async (req, res) => {
    try {
        if (!db) {
            return res.status(500).json({
                success: false,
                message:
                    "Database connection not available"
            });
        }

        const limitValue =
            Math.min(
                Math.max(
                    parseInt(req.query.limit) || 100,
                    1
                ),
                500
            );

        const offsetValue =
            Math.max(
                parseInt(req.query.offset) || 0,
                0
            );

        const result = await db.query(
            `
            SELECT *
            FROM personal_trading
            ORDER BY date DESC, created_at DESC
            LIMIT $1 OFFSET $2
            `,
            [
                limitValue,
                offsetValue
            ]
        );

        const countResult =
            await db.query(
                `
                SELECT COUNT(*)
                FROM personal_trading
                `
            );

        return res.json({
            success: true,
            count: result.rows.length,
            total: Number(
                countResult.rows[0].count
            ),
            data: result.rows
        });
    } catch (err) {
        console.error(
            "❌ Fetch all trades error:",
            err.message
        );

        return res.status(500).json({
            success: false,
            message: "Failed to fetch trades",
            error: err.message
        });
    }
});

// =============================================
// 5. GET - USER TRADES
// =============================================

router.get(
    "/user/:user_id",
    async (req, res) => {
        try {
            if (!db) {
                return res.status(500).json({
                    success: false,
                    message:
                        "Database connection not available"
                });
            }

            const { user_id } = req.params;

            const result =
                await db.query(
                    `
                    SELECT *
                    FROM personal_trading
                    WHERE user_id = $1
                    ORDER BY date DESC, created_at DESC
                    `,
                    [user_id]
                );

            return res.json({
                success: true,
                count: result.rows.length,
                data: result.rows
            });
        } catch (err) {
            console.error(
                "❌ Fetch user trades error:",
                err.message
            );

            return res.status(500).json({
                success: false,
                message:
                    "Failed to fetch trades",
                error: err.message
            });
        }
    }
);

// =============================================
// 6. GET - USER MONTH TRADES
// =============================================

router.get(
    "/user/:user_id/month/:month",
    async (req, res) => {
        try {
            if (!db) {
                return res.status(500).json({
                    success: false,
                    message:
                        "Database connection not available"
                });
            }

            const {
                user_id,
                month
            } = req.params;

            if (!/^\d{4}-\d{2}$/.test(month)) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Invalid month format. Use YYYY-MM"
                });
            }

            const result =
                await db.query(
                    `
                    SELECT *
                    FROM personal_trading
                    WHERE user_id = $1
                    AND TO_CHAR(date, 'YYYY-MM') = $2
                    ORDER BY date DESC, created_at DESC
                    `,
                    [
                        user_id,
                        month
                    ]
                );

            return res.json({
                success: true,
                count: result.rows.length,
                data: result.rows
            });
        } catch (err) {
            console.error(
                "❌ Fetch month trades error:",
                err.message
            );

            return res.status(500).json({
                success: false,
                message:
                    "Failed to fetch trades",
                error: err.message
            });
        }
    }
);

// =============================================
// 7. GET - MONTH STATISTICS
// =============================================

router.get(
    "/user/:user_id/month/:month/stats",
    async (req, res) => {
        try {
            if (!db) {
                return res.status(500).json({
                    success: false,
                    message:
                        "Database connection not available"
                });
            }

            const {
                user_id,
                month
            } = req.params;

            if (!/^\d{4}-\d{2}$/.test(month)) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Invalid month format. Use YYYY-MM"
                });
            }

            const result =
                await db.query(
                    `
                    SELECT *
                    FROM personal_trading
                    WHERE user_id = $1
                    AND TO_CHAR(date, 'YYYY-MM') = $2
                    ORDER BY date DESC, created_at DESC
                    `,
                    [
                        user_id,
                        month
                    ]
                );

            const trades = result.rows;

            const validTrades =
                trades.filter(
                    trade =>
                        Number.isFinite(
                            Number(
                                trade.profit_loss
                            )
                        )
                );

            const winningTrades =
                validTrades.filter(
                    trade =>
                        Number(
                            trade.profit_loss
                        ) > 0
                );

            const losingTrades =
                validTrades.filter(
                    trade =>
                        Number(
                            trade.profit_loss
                        ) < 0
                );

            const breakEvenTrades =
                validTrades.filter(
                    trade =>
                        Number(
                            trade.profit_loss
                        ) === 0
                );

            const totalProfit =
                winningTrades.reduce(
                    (sum, trade) =>
                        sum +
                        Number(
                            trade.profit_loss
                        ),
                    0
                );

            const totalLoss =
                losingTrades.reduce(
                    (sum, trade) =>
                        sum +
                        Math.abs(
                            Number(
                                trade.profit_loss
                            )
                        ),
                    0
                );

            const netProfit =
                totalProfit - totalLoss;

            // Win rate excludes break-even trades.
            const decidedTrades =
                winningTrades.length +
                losingTrades.length;

            const winRate =
                decidedTrades > 0
                    ? (
                        winningTrades.length /
                        decidedTrades
                    ) * 100
                    : 0;

            const avgProfit =
                winningTrades.length > 0
                    ? totalProfit /
                      winningTrades.length
                    : 0;

            const avgLoss =
                losingTrades.length > 0
                    ? totalLoss /
                      losingTrades.length
                    : 0;

            const bestTrade =
                winningTrades.length > 0
                    ? Math.max(
                        ...winningTrades.map(
                            trade =>
                                Number(
                                    trade.profit_loss
                                )
                        )
                    )
                    : 0;

            const worstTrade =
                losingTrades.length > 0
                    ? Math.min(
                        ...losingTrades.map(
                            trade =>
                                Number(
                                    trade.profit_loss
                                )
                        )
                    )
                    : 0;

            const profitFactor =
                totalLoss > 0
                    ? totalProfit / totalLoss
                    : totalProfit > 0
                        ? null
                        : 0;

            const totalBrokerage =
                validTrades.reduce(
                    (sum, trade) =>
                        sum +
                        Number(
                            trade.brokerage || 0
                        ),
                    0
                );

            const totalGrossProfit =
                validTrades.reduce(
                    (sum, trade) => {
                        const gross =
                            Number(
                                trade.gross_profit_loss ??
                                trade.profit_loss ??
                                0
                            );

                        return gross > 0
                            ? sum + gross
                            : sum;
                    },
                    0
                );

            const totalGrossLoss =
                validTrades.reduce(
                    (sum, trade) => {
                        const gross =
                            Number(
                                trade.gross_profit_loss ??
                                trade.profit_loss ??
                                0
                            );

                        return gross < 0
                            ? sum + Math.abs(gross)
                            : sum;
                    },
                    0
                );

            // =============================================
            // BROKER SUMMARY
            // =============================================

            const brokerSummary = {};

            validTrades.forEach(
                trade => {
                    const broker =
                        trade.broker ||
                        "Unknown";

                    if (!brokerSummary[broker]) {
                        brokerSummary[broker] = {
                            trades: 0,
                            profit: 0,
                            loss: 0,
                            brokerage: 0,
                            net: 0
                        };
                    }

                    brokerSummary[broker]
                        .trades++;

                    const pnl =
                        Number(
                            trade.profit_loss
                        );

                    brokerSummary[broker]
                        .brokerage +=
                        Number(
                            trade.brokerage || 0
                        );

                    brokerSummary[broker]
                        .net += pnl;

                    if (pnl > 0) {
                        brokerSummary[broker]
                            .profit += pnl;
                    }

                    if (pnl < 0) {
                        brokerSummary[broker]
                            .loss += Math.abs(pnl);
                    }
                }
            );

            // =============================================
            // SEGMENT SUMMARY
            // =============================================

            const segmentSummary = {};

            validTrades.forEach(
                trade => {
                    const segment =
                        trade.segment ||
                        "Unknown";

                    if (!segmentSummary[segment]) {
                        segmentSummary[segment] = {
                            trades: 0,
                            profit: 0,
                            loss: 0,
                            brokerage: 0,
                            net: 0
                        };
                    }

                    segmentSummary[segment]
                        .trades++;

                    const pnl =
                        Number(
                            trade.profit_loss
                        );

                    segmentSummary[segment]
                        .brokerage +=
                        Number(
                            trade.brokerage || 0
                        );

                    segmentSummary[segment]
                        .net += pnl;

                    if (pnl > 0) {
                        segmentSummary[segment]
                            .profit += pnl;
                    }

                    if (pnl < 0) {
                        segmentSummary[segment]
                            .loss += Math.abs(pnl);
                    }
                }
            );

            return res.json({
                success: true,
                data: {
                    trades,

                    stats: {
                        totalTrades:
                            validTrades.length,

                        winningTrades:
                            winningTrades.length,

                        losingTrades:
                            losingTrades.length,

                        breakEvenTrades:
                            breakEvenTrades.length,

                        totalProfit,

                        totalLoss,

                        netProfit,

                        totalBrokerage,

                        totalGrossProfit,

                        totalGrossLoss,

                        winRate,

                        avgProfit,

                        avgLoss,

                        bestTrade,

                        worstTrade,

                        profitFactor,

                        brokerSummary,

                        segmentSummary
                    }
                }
            });
        } catch (err) {
            console.error(
                "❌ Fetch month stats error:",
                err.message
            );

            return res.status(500).json({
                success: false,
                message:
                    "Failed to fetch statistics",
                error: err.message
            });
        }
    }
);

// =============================================
// 8. GET - SINGLE TRADE
// =============================================

router.get("/:id", async (req, res) => {
    try {
        if (!db) {
            return res.status(500).json({
                success: false,
                message:
                    "Database connection not available"
            });
        }

        const { id } = req.params;

        const result =
            await db.query(
                `
                SELECT *
                FROM personal_trading
                WHERE id = $1
                `,
                [id]
            );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Trade not found"
            });
        }

        return res.json({
            success: true,
            data: result.rows[0]
        });
    } catch (err) {
        console.error(
            "❌ Fetch trade error:",
            err.message
        );

        return res.status(500).json({
            success: false,
            message: "Failed to fetch trade",
            error: err.message
        });
    }
});

// =============================================
// 9. GET - DASHBOARD SUMMARY
// =============================================

router.get(
    "/dashboard/:user_id",
    async (req, res) => {
        try {
            if (!db) {
                return res.status(500).json({
                    success: false,
                    message:
                        "Database connection not available"
                });
            }

            const {
                user_id
            } = req.params;

            const result =
                await db.query(
                    `
                    SELECT
                        COUNT(*) AS total_trades,

                        COUNT(
                            CASE
                                WHEN profit_loss > 0
                                THEN 1
                            END
                        ) AS winning_trades,

                        COUNT(
                            CASE
                                WHEN profit_loss < 0
                                THEN 1
                            END
                        ) AS losing_trades,

                        COUNT(
                            CASE
                                WHEN profit_loss = 0
                                THEN 1
                            END
                        ) AS breakeven_trades,

                        COALESCE(
                            SUM(
                                CASE
                                    WHEN profit_loss > 0
                                    THEN profit_loss
                                    ELSE 0
                                END
                            ),
                            0
                        ) AS total_profit,

                        COALESCE(
                            SUM(
                                CASE
                                    WHEN profit_loss < 0
                                    THEN ABS(profit_loss)
                                    ELSE 0
                                END
                            ),
                            0
                        ) AS total_loss,

                        COALESCE(
                            SUM(profit_loss),
                            0
                        ) AS net_profit,

                        COALESCE(
                            SUM(brokerage),
                            0
                        ) AS total_brokerage,

                        COALESCE(
                            SUM(
                                CASE
                                    WHEN gross_profit_loss > 0
                                    THEN gross_profit_loss
                                    ELSE 0
                                END
                            ),
                            0
                        ) AS total_gross_profit,

                        COALESCE(
                            SUM(
                                CASE
                                    WHEN gross_profit_loss < 0
                                    THEN ABS(gross_profit_loss)
                                    ELSE 0
                                END
                            ),
                            0
                        ) AS total_gross_loss

                    FROM personal_trading
                    WHERE user_id = $1
                    `,
                    [user_id]
                );

            const stats =
                result.rows[0];

            const totalTrades =
                Number(
                    stats.total_trades || 0
                );

            const winningTrades =
                Number(
                    stats.winning_trades || 0
                );

            const losingTrades =
                Number(
                    stats.losing_trades || 0
                );

            const breakEvenTrades =
                Number(
                    stats.breakeven_trades || 0
                );

            const totalProfit =
                Number(
                    stats.total_profit || 0
                );

            const totalLoss =
                Number(
                    stats.total_loss || 0
                );

            const netProfit =
                Number(
                    stats.net_profit || 0
                );

            const totalBrokerage =
                Number(
                    stats.total_brokerage || 0
                );

            const totalGrossProfit =
                Number(
                    stats.total_gross_profit || 0
                );

            const totalGrossLoss =
                Number(
                    stats.total_gross_loss || 0
                );

            // Exclude break-even trades
            // from win-rate denominator.
            const decidedTrades =
                winningTrades +
                losingTrades;

            const winRate =
                decidedTrades > 0
                    ? (
                        winningTrades /
                        decidedTrades
                    ) * 100
                    : 0;

            const profitFactor =
                totalLoss > 0
                    ? totalProfit / totalLoss
                    : totalProfit > 0
                        ? null
                        : 0;

            // =============================================
            // RECENT TRADES
            // =============================================

            const recentTrades =
                await db.query(
                    `
                    SELECT *
                    FROM personal_trading
                    WHERE user_id = $1
                    ORDER BY date DESC, created_at DESC
                    LIMIT 10
                    `,
                    [user_id]
                );

            return res.json({
                success: true,

                data: {
                    stats: {
                        totalTrades,

                        winningTrades,

                        losingTrades,

                        breakEvenTrades,

                        totalProfit,

                        totalLoss,

                        netProfit,

                        totalBrokerage,

                        totalGrossProfit,

                        totalGrossLoss,

                        winRate,

                        profitFactor
                    },

                    recentTrades:
                        recentTrades.rows
                }
            });
        } catch (err) {
            console.error(
                "❌ Dashboard error:",
                err.message
            );

            return res.status(500).json({
                success: false,
                message:
                    "Failed to fetch dashboard data",
                error: err.message
            });
        }
    }
);

// =============================================
// EXPORT
// =============================================

module.exports = router;