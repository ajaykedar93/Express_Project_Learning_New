// personal_trading.js - CommonJS
// Professional Personal Trading API

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
// DATABASE TABLE + MIGRATION
// =============================================

const createTable = async () => {
    if (!db) {
        console.error("❌ Database connection not available");
        return;
    }

    try {
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

                calculation_mode VARCHAR(20)
                    NOT NULL DEFAULT 'price',

                profit_amount DECIMAL(20,8)
                    NOT NULL DEFAULT 0,

                loss_amount DECIMAL(20,8)
                    NOT NULL DEFAULT 0,

                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // =============================================
        // MIGRATION
        // =============================================

        const migrations = [

            `
            ALTER TABLE personal_trading
            ADD COLUMN IF NOT EXISTS gross_profit_loss
            DECIMAL(20,8) NOT NULL DEFAULT 0
            `,

            `
            ALTER TABLE personal_trading
            ADD COLUMN IF NOT EXISTS brokerage
            DECIMAL(20,8) NOT NULL DEFAULT 0
            `,

            `
            ALTER TABLE personal_trading
            ADD COLUMN IF NOT EXISTS status
            VARCHAR(20) DEFAULT 'Break-even'
            `,

            `
            ALTER TABLE personal_trading
            ADD COLUMN IF NOT EXISTS notes
            TEXT
            `,

            `
            ALTER TABLE personal_trading
            ADD COLUMN IF NOT EXISTS calculation_mode
            VARCHAR(20) NOT NULL DEFAULT 'price'
            `,

            `
            ALTER TABLE personal_trading
            ADD COLUMN IF NOT EXISTS profit_amount
            DECIMAL(20,8) NOT NULL DEFAULT 0
            `,

            `
            ALTER TABLE personal_trading
            ADD COLUMN IF NOT EXISTS loss_amount
            DECIMAL(20,8) NOT NULL DEFAULT 0
            `
        ];

        for (const sql of migrations) {
            try {
                await db.query(sql);
            } catch (err) {
                console.error(
                    "❌ Migration error:",
                    err.message
                );
            }
        }

        // Forex / decimal quantity support
        try {
            await db.query(`
                ALTER TABLE personal_trading
                ALTER COLUMN quantity
                TYPE DECIMAL(20,8)
                USING quantity::DECIMAL(20,8)
            `);
        } catch (err) {
            console.log(
                "ℹ️ Quantity migration:",
                err.message
            );
        }

        // Old records
        try {
            await db.query(`
                UPDATE personal_trading
                SET gross_profit_loss = profit_loss
                WHERE gross_profit_loss = 0
                  AND profit_loss <> 0
            `);
        } catch (err) {
            console.error(
                "❌ Old P&L migration:",
                err.message
            );
        }

        try {
            await db.query(`
                UPDATE personal_trading
                SET status =
                    CASE
                        WHEN profit_loss > 0
                            THEN 'Profit'
                        WHEN profit_loss < 0
                            THEN 'Loss'
                        ELSE 'Break-even'
                    END
                WHERE status IS NULL
                   OR status = ''
            `);
        } catch (err) {
            console.error(
                "❌ Status migration:",
                err.message
            );
        }

        console.log(
            "✅ personal_trading table ready"
        );

    } catch (err) {
        console.error(
            "❌ Table creation error:",
            err.message
        );
    }
};

createTable();

// =============================================
// HELPERS
// =============================================

const toNumber = (value, fallback = 0) => {
    if (
        value === null ||
        value === undefined ||
        value === ""
    ) {
        return fallback;
    }

    const number = Number(value);

    return Number.isFinite(number)
        ? number
        : fallback;
};

const roundNumber = (value) => {
    return Math.round(
        (Number(value) + Number.EPSILON) * 100000000
    ) / 100000000;
};

// =============================================
// CALCULATION
// =============================================
//
// PRICE MODE
//
// BUY:
// Gross = (Exit - Entry) × Quantity
//
// SELL:
// Gross = (Entry - Exit) × Quantity
//
// PROFIT:
// Net = Profit - Brokerage
//
// LOSS:
// Net = -(Loss + Brokerage)
//
// =============================================

const calculateTrade = ({
    type,
    quantity,
    entry_price,
    exit_price,
    brokerage,
    status,
    calculation_mode,
    profit_amount,
    loss_amount
}) => {

    const qty =
        toNumber(quantity, 0);

    const entry =
        toNumber(entry_price, 0);

    const exit =
        toNumber(exit_price, 0);

    const charges =
        Math.max(
            0,
            toNumber(brokerage, 0)
        );

    const mode =
        calculation_mode === "manual"
            ? "manual"
            : "price";

    const manualProfit =
        Math.max(
            0,
            toNumber(profit_amount, 0)
        );

    const manualLoss =
        Math.max(
            0,
            toNumber(loss_amount, 0)
        );

    let gross = 0;

    let savedProfit = 0;

    let savedLoss = 0;

    // =============================================
    // MANUAL MODE
    // =============================================

    if (mode === "manual") {

        if (
            status === "Loss" ||
            manualLoss > 0
        ) {

            gross = -manualLoss;

            savedLoss = manualLoss;

        } else if (
            status === "Profit" ||
            manualProfit > 0
        ) {

            gross = manualProfit;

            savedProfit = manualProfit;

        } else {

            gross = 0;
        }

    }

    // =============================================
    // PRICE MODE
    // =============================================

    else {

        if (type === "Sell") {

            gross =
                (entry - exit) * qty;

        } else {

            gross =
                (exit - entry) * qty;
        }

        if (gross > 0) {

            savedProfit = gross;

        } else if (gross < 0) {

            savedLoss =
                Math.abs(gross);
        }
    }

    // =============================================
    // NET CALCULATION
    // =============================================

    let net = 0;

    if (gross > 0) {

        // Profit - Brokerage
        net =
            gross - charges;

    } else if (gross < 0) {

        // Loss + Brokerage
        net =
            -(
                Math.abs(gross) +
                charges
            );

    } else {

        // No gross P&L
        net = -charges;
    }

    // =============================================
    // FINAL STATUS
    // =============================================

    let finalStatus =
        "Break-even";

    if (net > 0) {

        finalStatus = "Profit";

    } else if (net < 0) {

        finalStatus = "Loss";
    }

    return {

        quantity:
            roundNumber(qty),

        entry_price:
            roundNumber(entry),

        exit_price:
            roundNumber(exit),

        gross_profit_loss:
            roundNumber(gross),

        brokerage:
            roundNumber(charges),

        profit_loss:
            roundNumber(net),

        status:
            finalStatus,

        calculation_mode:
            mode,

        profit_amount:
            roundNumber(savedProfit),

        loss_amount:
            roundNumber(savedLoss)
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
        exit_price,
        brokerage,
        calculation_mode,
        profit_amount,
        loss_amount
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

    if (
        !["Buy", "Sell"].includes(type)
    ) {
        return "Type must be Buy or Sell";
    }

    const qty =
        Number(quantity);

    if (
        !Number.isFinite(qty) ||
        qty <= 0
    ) {
        return "Quantity must be greater than 0";
    }

    const brokerageValue =
        Number(brokerage || 0);

    if (
        !Number.isFinite(brokerageValue) ||
        brokerageValue < 0
    ) {
        return "Brokerage cannot be negative";
    }

    // =============================================
    // MANUAL MODE
    // =============================================

    if (
        calculation_mode === "manual"
    ) {

        const profit =
            Number(profit_amount || 0);

        const loss =
            Number(loss_amount || 0);

        if (
            !Number.isFinite(profit) ||
            profit < 0
        ) {
            return "Invalid profit amount";
        }

        if (
            !Number.isFinite(loss) ||
            loss < 0
        ) {
            return "Invalid loss amount";
        }

        if (
            profit > 0 &&
            loss > 0
        ) {
            return (
                "Enter either Profit Amount " +
                "or Loss Amount, not both"
            );
        }

        if (
            profit === 0 &&
            loss === 0 &&
            brokerageValue === 0
        ) {
            return (
                "Enter Profit Amount " +
                "or Loss Amount"
            );
        }

        return null;
    }

    // =============================================
    // PRICE MODE
    // =============================================

    const entry =
        Number(entry_price);

    const exit =
        Number(exit_price);

    if (
        !Number.isFinite(entry) ||
        entry < 0
    ) {
        return "Invalid entry price";
    }

    if (
        !Number.isFinite(exit) ||
        exit < 0
    ) {
        return "Invalid exit price";
    }

    return null;
};

// =============================================
// COMMON SELECT
// =============================================

const TRADE_SELECT = `
    SELECT
        id,
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
        notes,
        calculation_mode,
        profit_amount,
        loss_amount,
        created_at,
        updated_at
    FROM personal_trading
`;

// =============================================
// ADD TRADE
// POST /api/personal-trading/add
// =============================================

router.post(
    "/add",
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
                date,
                broker,
                segment,
                name,
                type,
                quantity,
                entry_price,
                exit_price,
                brokerage,
                status,
                calculation_mode,
                profit_amount,
                loss_amount,
                notes
            } = req.body;

            const validationError =
                validateTrade(req.body);

            if (validationError) {

                return res.status(400).json({
                    success: false,
                    message:
                        validationError
                });
            }

            const calculation =
                calculateTrade({
                    type,
                    quantity,
                    entry_price,
                    exit_price,
                    brokerage,
                    status,
                    calculation_mode,
                    profit_amount,
                    loss_amount
                });

            const result =
                await db.query(
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
                        notes,
                        calculation_mode,
                        profit_amount,
                        loss_amount
                    )
                    VALUES (
                        $1,$2,$3,$4,$5,$6,$7,
                        $8,$9,$10,$11,$12,$13,
                        $14,$15,$16,$17
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
                        notes || null,
                        calculation.calculation_mode,
                        calculation.profit_amount,
                        calculation.loss_amount
                    ]
                );

            return res.status(201).json({

                success: true,

                message:
                    "✅ Trade added successfully",

                data:
                    result.rows[0]
            });

        } catch (err) {

            console.error(
                "❌ Add trade error:",
                err.message
            );

            return res.status(500).json({

                success: false,

                message:
                    "Failed to add trade",

                error:
                    err.message
            });
        }
    }
);

// =============================================
// UPDATE TRADE
// PUT /api/personal-trading/update/:id
// =============================================

router.put(
    "/update/:id",
    async (req, res) => {

        try {

            if (!db) {
                return res.status(500).json({
                    success: false,
                    message:
                        "Database connection not available"
                });
            }

            const { id } =
                req.params;

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
                status,
                calculation_mode,
                profit_amount,
                loss_amount,
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
                    exit_price,
                    brokerage,
                    calculation_mode,
                    profit_amount,
                    loss_amount
                });

            if (validationError) {

                return res.status(400).json({
                    success: false,
                    message:
                        validationError
                });
            }

            const existing =
                await db.query(
                    `
                    SELECT id
                    FROM personal_trading
                    WHERE id = $1
                    `,
                    [id]
                );

            if (
                existing.rows.length === 0
            ) {

                return res.status(404).json({
                    success: false,
                    message:
                        "Trade not found"
                });
            }

            const calculation =
                calculateTrade({
                    type,
                    quantity,
                    entry_price,
                    exit_price,
                    brokerage,
                    status,
                    calculation_mode,
                    profit_amount,
                    loss_amount
                });

            const result =
                await db.query(
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
                        calculation_mode = $14,
                        profit_amount = $15,
                        loss_amount = $16,
                        updated_at =
                            CURRENT_TIMESTAMP
                    WHERE id = $17
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
                        calculation.calculation_mode,
                        calculation.profit_amount,
                        calculation.loss_amount,
                        id
                    ]
                );

            return res.json({

                success: true,

                message:
                    "✅ Trade updated successfully",

                data:
                    result.rows[0]
            });

        } catch (err) {

            console.error(
                "❌ Update trade error:",
                err.message
            );

            return res.status(500).json({

                success: false,

                message:
                    "Failed to update trade",

                error:
                    err.message
            });
        }
    }
);

// =============================================
// DELETE TRADE
// DELETE /api/personal-trading/delete/:id
// =============================================

router.delete(
    "/delete/:id",
    async (req, res) => {

        try {

            if (!db) {
                return res.status(500).json({
                    success: false,
                    message:
                        "Database connection not available"
                });
            }

            const { id } =
                req.params;

            const existing =
                await db.query(
                    `
                    SELECT id
                    FROM personal_trading
                    WHERE id = $1
                    `,
                    [id]
                );

            if (
                existing.rows.length === 0
            ) {

                return res.status(404).json({
                    success: false,
                    message:
                        "Trade not found"
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

                deletedId:
                    Number(id)
            });

        } catch (err) {

            console.error(
                "❌ Delete trade error:",
                err.message
            );

            return res.status(500).json({

                success: false,

                message:
                    "Failed to delete trade",

                error:
                    err.message
            });
        }
    }
);

// =============================================
// GET ALL
// GET /api/personal-trading/all
// =============================================

router.get(
    "/all",
    async (req, res) => {

        try {

            if (!db) {
                return res.status(500).json({
                    success: false,
                    message:
                        "Database connection not available"
                });
            }

            const limit =
                Math.min(
                    Math.max(
                        parseInt(
                            req.query.limit
                        ) || 100,
                        1
                    ),
                    500
                );

            const offset =
                Math.max(
                    parseInt(
                        req.query.offset
                    ) || 0,
                    0
                );

            const result =
                await db.query(
                    `
                    ${TRADE_SELECT}
                    ORDER BY
                        date DESC,
                        created_at DESC
                    LIMIT $1
                    OFFSET $2
                    `,
                    [
                        limit,
                        offset
                    ]
                );

            const count =
                await db.query(
                    `
                    SELECT COUNT(*)
                    FROM personal_trading
                    `
                );

            return res.json({

                success: true,

                count:
                    result.rows.length,

                total:
                    Number(
                        count.rows[0].count
                    ),

                data:
                    result.rows
            });

        } catch (err) {

            console.error(
                "❌ Get all trades error:",
                err.message
            );

            return res.status(500).json({

                success: false,

                message:
                    "Failed to fetch trades",

                error:
                    err.message
            });
        }
    }
);

// =============================================
// GET USER TRADES
// GET /api/personal-trading/user/:user_id
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

            const { user_id } =
                req.params;

            const result =
                await db.query(
                    `
                    ${TRADE_SELECT}
                    WHERE user_id = $1
                    ORDER BY
                        date DESC,
                        created_at DESC
                    `,
                    [user_id]
                );

            return res.json({

                success: true,

                count:
                    result.rows.length,

                data:
                    result.rows
            });

        } catch (err) {

            console.error(
                "❌ Get user trades error:",
                err.message
            );

            return res.status(500).json({

                success: false,

                message:
                    "Failed to fetch trades",

                error:
                    err.message
            });
        }
    }
);

// =============================================
// GET USER MONTH TRADES
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

            if (
                !/^\d{4}-\d{2}$/.test(
                    month
                )
            ) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Invalid month format. Use YYYY-MM"
                });
            }

            const result =
                await db.query(
                    `
                    ${TRADE_SELECT}
                    WHERE user_id = $1
                      AND TO_CHAR(
                          date,
                          'YYYY-MM'
                      ) = $2
                    ORDER BY
                        date DESC,
                        created_at DESC
                    `,
                    [
                        user_id,
                        month
                    ]
                );

            return res.json({

                success: true,

                count:
                    result.rows.length,

                data:
                    result.rows
            });

        } catch (err) {

            console.error(
                "❌ Get month trades error:",
                err.message
            );

            return res.status(500).json({

                success: false,

                message:
                    "Failed to fetch trades",

                error:
                    err.message
            });
        }
    }
);

// =============================================
// MONTH STATS
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

            if (
                !/^\d{4}-\d{2}$/.test(
                    month
                )
            ) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Invalid month format. Use YYYY-MM"
                });
            }

            const result =
                await db.query(
                    `
                    ${TRADE_SELECT}
                    WHERE user_id = $1
                      AND TO_CHAR(
                          date,
                          'YYYY-MM'
                      ) = $2
                    ORDER BY
                        date DESC,
                        created_at DESC
                    `,
                    [
                        user_id,
                        month
                    ]
                );

            const trades =
                result.rows;

            const net =
                trade =>
                    toNumber(
                        trade.profit_loss
                    );

            const gross =
                trade =>
                    toNumber(
                        trade.gross_profit_loss
                    );

            const brokerage =
                trade =>
                    Math.max(
                        0,
                        toNumber(
                            trade.brokerage
                        )
                    );

            // =============================================
            // WIN / LOSS
            // =============================================

            const wins =
                trades.filter(
                    t => net(t) > 0
                );

            const losses =
                trades.filter(
                    t => net(t) < 0
                );

            const breakEven =
                trades.filter(
                    t => net(t) === 0
                );

            // =============================================
            // NET PROFIT
            // =============================================

            const totalProfit =
                wins.reduce(
                    (sum, t) =>
                        sum + net(t),
                    0
                );

            // Loss is shown as positive
            // amount in statistics.
            const totalLoss =
                losses.reduce(
                    (sum, t) =>
                        sum + Math.abs(
                            net(t)
                        ),
                    0
                );

            const netProfit =
                totalProfit -
                totalLoss;

            // =============================================
            // BROKERAGE
            // =============================================

            const totalBrokerage =
                trades.reduce(
                    (sum, t) =>
                        sum + brokerage(t),
                    0
                );

            // =============================================
            // GROSS
            // =============================================

            const totalGrossProfit =
                trades.reduce(
                    (sum, t) => {

                        const value =
                            gross(t);

                        return value > 0
                            ? sum + value
                            : sum;
                    },
                    0
                );

            const totalGrossLoss =
                trades.reduce(
                    (sum, t) => {

                        const value =
                            gross(t);

                        return value < 0
                            ? sum +
                              Math.abs(value)
                            : sum;
                    },
                    0
                );

            const grossNet =
                totalGrossProfit -
                totalGrossLoss;

            // =============================================
            // WIN RATE
            // =============================================

            // Break-even trades are NOT
            // included in denominator.

            const decidedTrades =
                wins.length +
                losses.length;

            const winRate =
                decidedTrades > 0
                    ? (
                        wins.length /
                        decidedTrades
                    ) * 100
                    : 0;

            // =============================================
            // OTHER STATS
            // =============================================

            const avgProfit =
                wins.length > 0
                    ? totalProfit /
                      wins.length
                    : 0;

            const avgLoss =
                losses.length > 0
                    ? totalLoss /
                      losses.length
                    : 0;

            const bestTrade =
                wins.length > 0
                    ? Math.max(
                        ...wins.map(net)
                    )
                    : 0;

            const worstTrade =
                losses.length > 0
                    ? Math.min(
                        ...losses.map(net)
                    )
                    : 0;

            const profitFactor =
                totalLoss > 0
                    ? totalProfit /
                      totalLoss
                    : totalProfit > 0
                        ? null
                        : 0;

            // =============================================
            // DAILY BAR DATA
            // =============================================

            const daily = {};

            trades.forEach(
                trade => {

                    const date =
                        String(
                            trade.date
                        ).slice(0, 10);

                    if (!daily[date]) {

                        daily[date] = {
                            profit: 0,
                            loss: 0,
                            net: 0,
                            brokerage: 0,
                            trades: 0
                        };
                    }

                    const pnl =
                        net(trade);

                    daily[date].trades++;

                    daily[date].net +=
                        pnl;

                    daily[date].brokerage +=
                        brokerage(trade);

                    if (pnl > 0) {

                        daily[date].profit +=
                            pnl;

                    } else if (pnl < 0) {

                        daily[date].loss +=
                            Math.abs(pnl);
                    }
                }
            );

            const dailyBarData =
                Object.keys(daily)
                    .sort()
                    .map(date => ({

                        date,

                        profit:
                            roundNumber(
                                daily[date]
                                    .profit
                            ),

                        loss:
                            roundNumber(
                                daily[date]
                                    .loss
                            ),

                        net:
                            roundNumber(
                                daily[date]
                                    .net
                            ),

                        brokerage:
                            roundNumber(
                                daily[date]
                                    .brokerage
                            ),

                        trades:
                            daily[date]
                                .trades
                    }));

            // =============================================
            // BROKER SUMMARY
            // =============================================

            const brokerSummary = {};

            trades.forEach(
                trade => {

                    const brokerName =
                        trade.broker ||
                        "Unknown";

                    if (
                        !brokerSummary[
                            brokerName
                        ]
                    ) {

                        brokerSummary[
                            brokerName
                        ] = {

                            trades: 0,

                            profit: 0,

                            loss: 0,

                            brokerage: 0,

                            net: 0
                        };
                    }

                    const pnl =
                        net(trade);

                    brokerSummary[
                        brokerName
                    ].trades++;

                    brokerSummary[
                        brokerName
                    ].brokerage +=
                        brokerage(trade);

                    brokerSummary[
                        brokerName
                    ].net += pnl;

                    if (pnl > 0) {

                        brokerSummary[
                            brokerName
                        ].profit += pnl;

                    } else if (pnl < 0) {

                        brokerSummary[
                            brokerName
                        ].loss +=
                            Math.abs(pnl);
                    }
                }
            );

            // =============================================
            // SEGMENT SUMMARY
            // =============================================

            const segmentSummary = {};

            trades.forEach(
                trade => {

                    const segment =
                        trade.segment ||
                        "Unknown";

                    if (
                        !segmentSummary[
                            segment
                        ]
                    ) {

                        segmentSummary[
                            segment
                        ] = {

                            trades: 0,

                            profit: 0,

                            loss: 0,

                            brokerage: 0,

                            net: 0
                        };
                    }

                    const pnl =
                        net(trade);

                    segmentSummary[
                        segment
                    ].trades++;

                    segmentSummary[
                        segment
                    ].brokerage +=
                        brokerage(trade);

                    segmentSummary[
                        segment
                    ].net += pnl;

                    if (pnl > 0) {

                        segmentSummary[
                            segment
                        ].profit += pnl;

                    } else if (pnl < 0) {

                        segmentSummary[
                            segment
                        ].loss +=
                            Math.abs(pnl);
                    }
                }
            );

            // =============================================
            // RESPONSE
            // =============================================

            return res.json({

                success: true,

                data: {

                    trades,

                    stats: {

                        totalTrades:
                            trades.length,

                        winningTrades:
                            wins.length,

                        losingTrades:
                            losses.length,

                        breakEvenTrades:
                            breakEven.length,

                        decidedTrades,

                        // NET AFTER BROKERAGE
                        totalProfit:
                            roundNumber(
                                totalProfit
                            ),

                        totalLoss:
                            roundNumber(
                                totalLoss
                            ),

                        netProfit:
                            roundNumber(
                                netProfit
                            ),

                        // BROKERAGE
                        totalBrokerage:
                            roundNumber(
                                totalBrokerage
                            ),

                        // GROSS BEFORE BROKERAGE
                        totalGrossProfit:
                            roundNumber(
                                totalGrossProfit
                            ),

                        totalGrossLoss:
                            roundNumber(
                                totalGrossLoss
                            ),

                        grossNet:
                            roundNumber(
                                grossNet
                            ),

                        winRate:
                            roundNumber(
                                winRate
                            ),

                        avgProfit:
                            roundNumber(
                                avgProfit
                            ),

                        avgLoss:
                            roundNumber(
                                avgLoss
                            ),

                        bestTrade:
                            roundNumber(
                                bestTrade
                            ),

                        worstTrade:
                            roundNumber(
                                worstTrade
                            ),

                        profitFactor:
                            profitFactor === null
                                ? null
                                : roundNumber(
                                    profitFactor
                                ),

                        brokerSummary,

                        segmentSummary,

                        // For frontend
                        // professional bar chart
                        dailyBarData
                    }
                }
            });

        } catch (err) {

            console.error(
                "❌ Month stats error:",
                err.message
            );

            return res.status(500).json({

                success: false,

                message:
                    "Failed to fetch statistics",

                error:
                    err.message
            });
        }
    }
);

// =============================================
// GET SINGLE TRADE
// =============================================

router.get(
    "/:id",
    async (req, res) => {

        try {

            if (!db) {
                return res.status(500).json({
                    success: false,
                    message:
                        "Database connection not available"
                });
            }

            const { id } =
                req.params;

            const result =
                await db.query(
                    `
                    ${TRADE_SELECT}
                    WHERE id = $1
                    `,
                    [id]
                );

            if (
                result.rows.length === 0
            ) {

                return res.status(404).json({
                    success: false,
                    message:
                        "Trade not found"
                });
            }

            return res.json({

                success: true,

                data:
                    result.rows[0]
            });

        } catch (err) {

            console.error(
                "❌ Get single trade error:",
                err.message
            );

            return res.status(500).json({

                success: false,

                message:
                    "Failed to fetch trade",

                error:
                    err.message
            });
        }
    }
);

// =============================================
// DASHBOARD SUMMARY
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

            const { user_id } =
                req.params;

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
                                    THEN ABS(
                                        profit_loss
                                    )
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
                                    THEN ABS(
                                        gross_profit_loss
                                    )
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

            const row =
                result.rows[0];

            const totalTrades =
                Number(
                    row.total_trades || 0
                );

            const winningTrades =
                Number(
                    row.winning_trades || 0
                );

            const losingTrades =
                Number(
                    row.losing_trades || 0
                );

            const breakEvenTrades =
                Number(
                    row.breakeven_trades || 0
                );

            const totalProfit =
                Number(
                    row.total_profit || 0
                );

            const totalLoss =
                Number(
                    row.total_loss || 0
                );

            const netProfit =
                Number(
                    row.net_profit || 0
                );

            const totalBrokerage =
                Number(
                    row.total_brokerage || 0
                );

            const totalGrossProfit =
                Number(
                    row.total_gross_profit || 0
                );

            const totalGrossLoss =
                Number(
                    row.total_gross_loss || 0
                );

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
                    ? totalProfit /
                      totalLoss
                    : totalProfit > 0
                        ? null
                        : 0;

            const recentTrades =
                await db.query(
                    `
                    ${TRADE_SELECT}
                    WHERE user_id = $1
                    ORDER BY
                        date DESC,
                        created_at DESC
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

                        decidedTrades,

                        totalProfit:
                            roundNumber(
                                totalProfit
                            ),

                        totalLoss:
                            roundNumber(
                                totalLoss
                            ),

                        netProfit:
                            roundNumber(
                                netProfit
                            ),

                        totalBrokerage:
                            roundNumber(
                                totalBrokerage
                            ),

                        totalGrossProfit:
                            roundNumber(
                                totalGrossProfit
                            ),

                        totalGrossLoss:
                            roundNumber(
                                totalGrossLoss
                            ),

                        winRate:
                            roundNumber(
                                winRate
                            ),

                        profitFactor:
                            profitFactor === null
                                ? null
                                : roundNumber(
                                    profitFactor
                                )
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

                error:
                    err.message
            });
        }
    }
);

// =============================================
// EXPORT
// =============================================

module.exports = router;