// personal_trading.js - CommonJS
// Professional Personal Trading API with Export Functionality

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
// =============================================
// PROFESSIONAL REPORT EXPORT API
// =============================================

// =============================================
// CREATE REPORT DATE RANGE
// =============================================

const createReportDateRange = (period, dateValue, monthValue) => {
    let startDate;
    let endDate;

    if (period === "daily") {
        if (!dateValue || !/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
            throw new Error("Daily report requires date=YYYY-MM-DD");
        }

        const date = new Date(`${dateValue}T00:00:00`);

        if (Number.isNaN(date.getTime())) {
            throw new Error("Invalid daily report date");
        }

        startDate = new Date(
            date.getFullYear(),
            date.getMonth(),
            date.getDate()
        );

        endDate = new Date(startDate);
        endDate.setDate(endDate.getDate() + 1);

    } else if (period === "weekly") {
        if (!dateValue || !/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
            throw new Error("Weekly report requires date=YYYY-MM-DD");
        }

        const selected = new Date(`${dateValue}T00:00:00`);

        if (Number.isNaN(selected.getTime())) {
            throw new Error("Invalid weekly report date");
        }

        const dayOfWeek = selected.getDay();

        const diff =
            selected.getDate() -
            dayOfWeek +
            (dayOfWeek === 0 ? -6 : 1);

        startDate = new Date(
            selected.getFullYear(),
            selected.getMonth(),
            diff
        );

        endDate = new Date(startDate);
        endDate.setDate(startDate.getDate() + 7);

    } else {
        if (!monthValue || !/^\d{4}-\d{2}$/.test(monthValue)) {
            throw new Error("Monthly report requires month=YYYY-MM");
        }

        const [year, month] = monthValue
            .split("-")
            .map(Number);

        startDate = new Date(year, month - 1, 1);
        endDate = new Date(year, month, 1);
    }

    return {
        startDate,
        endDate
    };
};

// =============================================
// FORMAT HELPERS
// =============================================

const exportNumber = (value) => {
    const number = Number(value);

    if (!Number.isFinite(number)) {
        return 0;
    }

    return Math.round(
        (number + Number.EPSILON) * 100
    ) / 100;
};

const exportCurrency = (value) => {
    const number = exportNumber(value);

    return `₹${number.toLocaleString("en-IN", {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2
    })}`;
};

const exportDate = (value) => {
    if (!value) {
        return "";
    }

    const date = new Date(
        `${String(value).slice(0, 10)}T00:00:00`
    );

    if (Number.isNaN(date.getTime())) {
        return String(value);
    }

    return date.toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric"
    });
};

const exportSafeText = (value) => {
    return String(value ?? "")
        .replace(/\r?\n/g, " ")
        .trim();
};

// =============================================
// GET EXPORT REPORT DATA
// =============================================

const getExportReportData = async (
    userId,
    period,
    dateValue,
    monthValue
) => {

    const {
        startDate,
        endDate
    } = createReportDateRange(
        period,
        dateValue,
        monthValue
    );

    const result = await db.query(
        `
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
        WHERE user_id = $1
          AND date >= $2
          AND date < $3
        ORDER BY
            date DESC,
            created_at DESC
        `,
        [
            userId,
            startDate,
            endDate
        ]
    );

    const trades = result.rows;

    let totalProfit = 0;
    let totalLoss = 0;
    let totalGrossProfit = 0;
    let totalGrossLoss = 0;
    let totalBrokerage = 0;
    let netProfit = 0;

    let winningTrades = 0;
    let losingTrades = 0;
    let breakEvenTrades = 0;

    const dailyMap = {};

    trades.forEach((trade) => {

        const net =
            exportNumber(trade.profit_loss);

        const gross =
            exportNumber(trade.gross_profit_loss);

        const brokerage =
            Math.max(
                0,
                exportNumber(trade.brokerage)
            );

        if (net > 0) {
            totalProfit += net;
            winningTrades++;
        } else if (net < 0) {
            totalLoss += Math.abs(net);
            losingTrades++;
        } else {
            breakEvenTrades++;
        }

        if (gross > 0) {
            totalGrossProfit += gross;
        } else if (gross < 0) {
            totalGrossLoss += Math.abs(gross);
        }

        totalBrokerage += brokerage;
        netProfit += net;

        const dateKey =
            String(trade.date).slice(0, 10);

        if (!dailyMap[dateKey]) {
            dailyMap[dateKey] = {
                profit: 0,
                loss: 0,
                net: 0,
                brokerage: 0,
                trades: 0
            };
        }

        dailyMap[dateKey].trades += 1;
        dailyMap[dateKey].net += net;
        dailyMap[dateKey].brokerage += brokerage;

        if (net > 0) {
            dailyMap[dateKey].profit += net;
        }

        if (net < 0) {
            dailyMap[dateKey].loss += Math.abs(net);
        }
    });

    const decidedTrades =
        winningTrades + losingTrades;

    const winRate =
        decidedTrades > 0
            ? (winningTrades / decidedTrades) * 100
            : 0;

    const profitFactor =
        totalLoss > 0
            ? totalProfit / totalLoss
            : totalProfit > 0
                ? null
                : 0;

    const daily = Object.keys(dailyMap)
        .sort()
        .map((date) => ({
            date,
            profit: exportNumber(
                dailyMap[date].profit
            ),
            loss: exportNumber(
                dailyMap[date].loss
            ),
            net: exportNumber(
                dailyMap[date].net
            ),
            brokerage: exportNumber(
                dailyMap[date].brokerage
            ),
            trades:
                dailyMap[date].trades
        }));

    return {
        trades,

        summary: {
            totalTrades: trades.length,
            winningTrades,
            losingTrades,
            breakEvenTrades,
            decidedTrades,

            totalProfit:
                exportNumber(totalProfit),

            totalLoss:
                exportNumber(totalLoss),

            netProfit:
                exportNumber(netProfit),

            totalGrossProfit:
                exportNumber(totalGrossProfit),

            totalGrossLoss:
                exportNumber(totalGrossLoss),

            totalBrokerage:
                exportNumber(totalBrokerage),

            winRate:
                exportNumber(winRate),

            profitFactor:
                profitFactor === null
                    ? null
                    : exportNumber(profitFactor)
        },

        daily
    };
};

// =============================================
// REPORT TITLE
// =============================================

const getExportReportTitle = (
    period,
    dateValue,
    monthValue
) => {

    if (period === "daily") {
        return `Daily Trading Report - ${dateValue}`;
    }

    if (period === "weekly") {
        return `Weekly Trading Report - ${dateValue}`;
    }

    return `Monthly Trading Report - ${monthValue}`;
};

// =============================================
// TEXT REPORT
// =============================================

const createTextReport = (
    title,
    report
) => {

    const lines = [];

    lines.push(
        "============================================================"
    );

    lines.push(
        "                    TRADING JOURNAL"
    );

    lines.push(
        "                   PROFESSIONAL REPORT"
    );

    lines.push(
        "============================================================"
    );

    lines.push("");

    lines.push(`Report: ${title}`);

    lines.push(
        `Generated: ${new Date().toLocaleString("en-IN")}`
    );

    lines.push("");

    lines.push(
        "-------------------- SUMMARY --------------------"
    );

    lines.push(
        `Total Trades      : ${report.summary.totalTrades}`
    );

    lines.push(
        `Winning Trades    : ${report.summary.winningTrades}`
    );

    lines.push(
        `Losing Trades     : ${report.summary.losingTrades}`
    );

    lines.push(
        `Break-even Trades : ${report.summary.breakEvenTrades}`
    );

    lines.push(
        `Win Rate          : ${report.summary.winRate.toFixed(2)}%`
    );

    lines.push(
        `Gross Profit      : ${exportCurrency(report.summary.totalGrossProfit)}`
    );

    lines.push(
        `Gross Loss        : ${exportCurrency(report.summary.totalGrossLoss)}`
    );

    lines.push(
        `Brokerage         : ${exportCurrency(report.summary.totalBrokerage)}`
    );

    lines.push(
        `Net Profit/Loss   : ${exportCurrency(report.summary.netProfit)}`
    );

    lines.push(
        `Profit Factor     : ${
            report.summary.profitFactor === null
                ? "∞"
                : report.summary.profitFactor.toFixed(2)
        }`
    );

    lines.push("");

    lines.push(
        "-------------------- DAILY P&L --------------------"
    );

    lines.push(
        "Date | Trades | Profit | Loss | Brokerage | Net P&L"
    );

    lines.push(
        "----------------------------------------------------"
    );

    report.daily.forEach((item) => {

        lines.push(
            [
                item.date,
                item.trades,
                exportCurrency(item.profit),
                exportCurrency(item.loss),
                exportCurrency(item.brokerage),
                exportCurrency(item.net)
            ].join(" | ")
        );
    });

    lines.push("");

    lines.push(
        "-------------------- TRADE DETAILS --------------------"
    );

    lines.push("");

    report.trades.forEach((trade, index) => {

        lines.push(
            `Trade #${index + 1}`
        );

        lines.push(
            `Date        : ${exportDate(trade.date)}`
        );

        lines.push(
            `Market      : ${trade.segment || ""}`
        );

        lines.push(
            `Broker      : ${trade.broker || ""}`
        );

        lines.push(
            `Name        : ${trade.name || ""}`
        );

        lines.push(
            `Type        : ${trade.type || ""}`
        );

        lines.push(
            `Lot Size    : ${exportNumber(trade.quantity)}`
        );

        lines.push(
            `Entry       : ${exportNumber(trade.entry_price)}`
        );

        lines.push(
            `Exit        : ${exportNumber(trade.exit_price)}`
        );

        lines.push(
            `Gross       : ${exportCurrency(trade.gross_profit_loss)}`
        );

        lines.push(
            `Brokerage   : ${exportCurrency(trade.brokerage)}`
        );

        lines.push(
            `Net P&L     : ${exportCurrency(trade.profit_loss)}`
        );

        lines.push(
            `Status      : ${trade.status || ""}`
        );

        lines.push(
            `Notes       : ${exportSafeText(trade.notes)}`
        );

        lines.push(
            "----------------------------------------------------"
        );
    });

    lines.push("");

    lines.push(
        "Generated by Personal Trading Journal"
    );

    return lines.join("\n");
};

// =============================================
// EXCEL REPORT
// =============================================

const createExcelReport = async (
    title,
    report
) => {

    let ExcelJS;

    try {
        ExcelJS = require("exceljs");
    } catch {
        throw new Error(
            "ExcelJS is not installed. Run: npm install exceljs"
        );
    }

    const workbook =
        new ExcelJS.Workbook();

    workbook.creator =
        "Personal Trading Journal";

    workbook.lastModifiedBy =
        "Personal Trading Journal";

    workbook.created =
        new Date();

    workbook.modified =
        new Date();

    const sheet =
        workbook.addWorksheet(
            "Trading Report",
            {
                views: [
                    {
                        state: "frozen",
                        ySplit: 7
                    }
                ]
            }
        );

    sheet.mergeCells(
        "A1:M1"
    );

    sheet.getCell("A1").value =
        "TRADING JOURNAL REPORT";

    sheet.getCell("A1").font = {
        bold: true,
        size: 18,
        color: {
            argb: "FFFFFFFF"
        }
    };

    sheet.getCell("A1").alignment = {
        horizontal: "center",
        vertical: "middle"
    };

    sheet.getCell("A1").fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: {
            argb: "FF1F2937"
        }
    };

    sheet.getRow(1).height = 30;

    sheet.mergeCells(
        "A2:M2"
    );

    sheet.getCell("A2").value =
        title;

    sheet.getCell("A2").font = {
        bold: true,
        size: 11,
        color: {
            argb: "FF374151"
        }
    };

    sheet.mergeCells(
        "A3:M3"
    );

    sheet.getCell("A3").value =
        `Generated: ${new Date().toLocaleString("en-IN")}`;

    sheet.getCell("A3").font = {
        size: 9,
        color: {
            argb: "FF6B7280"
        }
    };

    // Summary
    sheet.mergeCells(
        "A5:M5"
    );

    sheet.getCell("A5").value =
        "SUMMARY";

    sheet.getCell("A5").font = {
        bold: true,
        color: {
            argb: "FFFFFFFF"
        }
    };

    sheet.getCell("A5").fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: {
            argb: "FF4F46E5"
        }
    };

    const summaryRows = [
        [
            "Total Trades",
            report.summary.totalTrades
        ],
        [
            "Winning Trades",
            report.summary.winningTrades
        ],
        [
            "Losing Trades",
            report.summary.losingTrades
        ],
        [
            "Break-even Trades",
            report.summary.breakEvenTrades
        ],
        [
            "Win Rate",
            `${report.summary.winRate.toFixed(2)}%`
        ],
        [
            "Gross Profit",
            exportCurrency(
                report.summary.totalGrossProfit
            )
        ],
        [
            "Gross Loss",
            exportCurrency(
                report.summary.totalGrossLoss
            )
        ],
        [
            "Brokerage",
            exportCurrency(
                report.summary.totalBrokerage
            )
        ],
        [
            "Net P&L",
            exportCurrency(
                report.summary.netProfit
            )
        ],
        [
            "Profit Factor",
            report.summary.profitFactor === null
                ? "∞"
                : report.summary.profitFactor.toFixed(2)
        ]
    ];

    let summaryRowNumber = 6;

    summaryRows.forEach(
        ([label, value]) => {

            sheet.getCell(
                `A${summaryRowNumber}`
            ).value = label;

            sheet.getCell(
                `B${summaryRowNumber}`
            ).value = value;

            sheet.getCell(
                `A${summaryRowNumber}`
            ).font = {
                bold: true
            };

            summaryRowNumber++;
        }
    );

    const headerRow =
        summaryRowNumber + 1;

    sheet.mergeCells(
        `A${headerRow}:M${headerRow}`
    );

    sheet.getCell(
        `A${headerRow}`
    ).value =
        "TRADE DETAILS";

    sheet.getCell(
        `A${headerRow}`
    ).font = {
        bold: true,
        color: {
            argb: "FFFFFFFF"
        }
    };

    sheet.getCell(
        `A${headerRow}`
    ).fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: {
            argb: "FF111827"
        }
    };

    const tableHeaderRow =
        headerRow + 1;

    const columns = [
        "Date",
        "Market",
        "Name",
        "Broker",
        "Segment",
        "Type",
        "Lot Size",
        "Entry",
        "Exit",
        "Gross",
        "Brokerage",
        "Net P&L",
        "Status"
    ];

    sheet.getRow(
        tableHeaderRow
    ).values = columns;

    sheet.getRow(
        tableHeaderRow
    ).font = {
        bold: true,
        color: {
            argb: "FFFFFFFF"
        }
    };

    sheet.getRow(
        tableHeaderRow
    ).fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: {
            argb: "FF374151"
        }
    };

    report.trades.forEach(
        (trade) => {

            const row =
                sheet.addRow([
                    exportDate(trade.date),
                    trade.segment || "",
                    trade.name || "",
                    trade.broker || "",
                    trade.segment || "",
                    trade.type || "",
                    exportNumber(trade.quantity),
                    exportNumber(trade.entry_price),
                    exportNumber(trade.exit_price),
                    exportNumber(trade.gross_profit_loss),
                    exportNumber(trade.brokerage),
                    exportNumber(trade.profit_loss),
                    trade.status || ""
                ]);

            row.eachCell(
                (cell) => {
                    cell.border = {
                        top: {
                            style: "thin",
                            color: {
                                argb: "FFD1D5DB"
                            }
                        },
                        left: {
                            style: "thin",
                            color: {
                                argb: "FFD1D5DB"
                            }
                        },
                        bottom: {
                            style: "thin",
                            color: {
                                argb: "FFD1D5DB"
                            }
                        },
                        right: {
                            style: "thin",
                            color: {
                                argb: "FFD1D5DB"
                            }
                        }
                    };
                }
            );

            const netCell =
                row.getCell(12);

            if (
                Number(trade.profit_loss) > 0
            ) {
                netCell.font = {
                    bold: true,
                    color: {
                        argb: "FF059669"
                    }
                };
            }

            if (
                Number(trade.profit_loss) < 0
            ) {
                netCell.font = {
                    bold: true,
                    color: {
                        argb: "FFDC2626"
                    }
                };
            }
        }
    );

    const widths = [
        14,
        14,
        22,
        16,
        16,
        10,
        12,
        14,
        14,
        15,
        15,
        15,
        14
    ];

    widths.forEach(
        (width, index) => {
            sheet.getColumn(
                index + 1
            ).width = width;
        }
    );

    // Daily chart sheet
    const chartSheet =
        workbook.addWorksheet(
            "Daily P&L"
        );

    chartSheet.addRow([
        "Date",
        "Trades",
        "Profit",
        "Loss",
        "Brokerage",
        "Net P&L"
    ]);

    chartSheet.getRow(1).font = {
        bold: true,
        color: {
            argb: "FFFFFFFF"
        }
    };

    chartSheet.getRow(1).fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: {
            argb: "FF111827"
        }
    };

    report.daily.forEach(
        (day) => {
            chartSheet.addRow([
                day.date,
                day.trades,
                day.profit,
                day.loss,
                day.brokerage,
                day.net
            ]);
        }
    );

    chartSheet.columns.forEach(
        (column) => {
            column.width = 16;
        }
    );

    return workbook.xlsx.writeBuffer();
};

// =============================================
// PDF REPORT
// =============================================

const createPdfReport = (
    title,
    report,
    res
) => {

    let PDFDocument;

    try {
        PDFDocument = require("pdfkit");
    } catch {
        throw new Error(
            "PDFKit is not installed. Run: npm install pdfkit"
        );
    }

    const doc =
        new PDFDocument({
            size: "A4",
            layout: "landscape",
            margins: {
                top: 36,
                bottom: 36,
                left: 32,
                right: 32
            }
        });

    res.setHeader(
        "Content-Type",
        "application/pdf"
    );

    res.setHeader(
        "Content-Disposition",
        `attachment; filename="${title
            .replace(/[^a-z0-9]+/gi, "-")
            .toLowerCase()}.pdf"`
    );

    doc.pipe(res);

    doc
        .fontSize(20)
        .fillColor("#111827")
        .text(
            "TRADING JOURNAL REPORT",
            {
                align: "center"
            }
        );

    doc
        .moveDown(0.3)
        .fontSize(11)
        .fillColor("#4B5563")
        .text(
            title,
            {
                align: "center"
            }
        );

    doc
        .moveDown(0.2)
        .fontSize(8)
        .fillColor("#6B7280")
        .text(
            `Generated: ${new Date().toLocaleString("en-IN")}`,
            {
                align: "center"
            }
        );

    doc.moveDown(1);

    // Summary boxes
    const summary = report.summary;

    const summaryItems = [
        ["Trades", summary.totalTrades],
        ["Win Rate", `${summary.winRate.toFixed(2)}%`],
        ["Gross Profit", exportCurrency(summary.totalGrossProfit)],
        ["Gross Loss", exportCurrency(summary.totalGrossLoss)],
        ["Brokerage", exportCurrency(summary.totalBrokerage)],
        ["Net P&L", exportCurrency(summary.netProfit)]
    ];

    const boxWidth = 120;
    const boxHeight = 52;
    const gap = 12;

    let x =
        doc.page.margins.left;

    const y =
        doc.y;

    summaryItems.forEach(
        ([label, value]) => {

            doc.roundedRect(
                x,
                y,
                boxWidth,
                boxHeight,
                8
            )
                .fillAndStroke(
                    "#F8FAFC",
                    "#CBD5E1"
                );

            doc
                .fontSize(7)
                .fillColor("#64748B")
                .text(
                    label,
                    x + 8,
                    y + 8,
                    {
                        width: boxWidth - 16,
                        align: "center"
                    }
                );

            doc
                .fontSize(12)
                .fillColor(
                    label === "Net P&L"
                        ? summary.netProfit >= 0
                            ? "#059669"
                            : "#DC2626"
                        : "#111827"
                )
                .text(
                    String(value),
                    x + 8,
                    y + 25,
                    {
                        width: boxWidth - 16,
                        align: "center"
                    }
                );

            x +=
                boxWidth + gap;
        }
    );

    doc.y =
        y + boxHeight + 22;

    // Table
    const tableHeaders = [
        "Date",
        "Market",
        "Name",
        "Broker",
        "Type",
        "Lot",
        "Entry",
        "Exit",
        "Gross",
        "Brokerage",
        "Net P&L",
        "Status"
    ];

    const tableX =
        doc.page.margins.left;

    const tableWidth =
        doc.page.width -
        doc.page.margins.left -
        doc.page.margins.right;

    const columnWidth =
        tableWidth /
        tableHeaders.length;

    let tableY =
        doc.y;

    const drawHeader = () => {

        doc
            .rect(
                tableX,
                tableY,
                tableWidth,
                22
            )
            .fill("#111827");

        tableHeaders.forEach(
            (header, index) => {

                doc
                    .fontSize(6.5)
                    .fillColor("#FFFFFF")
                    .text(
                        header,
                        tableX +
                            index *
                            columnWidth +
                            3,
                        tableY + 7,
                        {
                            width:
                                columnWidth - 6,
                            align: "center",
                            lineBreak: false
                        }
                    );
            }
        );

        tableY += 22;
    };

    drawHeader();

    report.trades.forEach(
        (trade, index) => {

            if (
                tableY >
                doc.page.height - 55
            ) {
                doc.addPage({
                    size: "A4",
                    layout: "landscape",
                    margins: {
                        top: 36,
                        bottom: 36,
                        left: 32,
                        right: 32
                    }
                });

                tableY = 36;

                drawHeader();
            }

            const rowHeight = 22;

            if (index % 2 === 0) {
                doc
                    .rect(
                        tableX,
                        tableY,
                        tableWidth,
                        rowHeight
                    )
                    .fill("#F8FAFC");
            }

            const values = [
                exportDate(trade.date),
                trade.segment || "",
                exportSafeText(trade.name),
                exportSafeText(trade.broker),
                trade.type || "",
                exportNumber(trade.quantity),
                exportNumber(trade.entry_price),
                exportNumber(trade.exit_price),
                exportCurrency(trade.gross_profit_loss),
                exportCurrency(trade.brokerage),
                exportCurrency(trade.profit_loss),
                trade.status || ""
            ];

            values.forEach(
                (value, columnIndex) => {

                    const color =
                        columnIndex === 10
                            ? Number(trade.profit_loss) >= 0
                                ? "#059669"
                                : "#DC2626"
                            : "#111827";

                    doc
                        .fontSize(6.2)
                        .fillColor(color)
                        .text(
                            String(value),
                            tableX +
                                columnIndex *
                                columnWidth +
                                3,
                            tableY + 7,
                            {
                                width:
                                    columnWidth - 6,
                                align: "center",
                                lineBreak: false
                            }
                        );
                }
            );

            doc
                .rect(
                    tableX,
                    tableY,
                    tableWidth,
                    rowHeight
                )
                .strokeColor("#E5E7EB")
                .lineWidth(0.5)
                .stroke();

            tableY += rowHeight;
        }
    );

    doc
        .fontSize(7)
        .fillColor("#6B7280")
        .text(
            "Generated by Personal Trading Journal",
            tableX,
            doc.page.height - 28,
            {
                width: tableWidth,
                align: "center"
            }
        );

    doc.end();
};

// =============================================
// EXPORT ROUTE
// GET /api/personal-trading/export/:user_id
// =============================================

router.get(
    "/export/:user_id",
    async (req, res) => {

        try {

            if (!db) {
                return res.status(500).json({
                    success: false,
                    message:
                        "Database connection not available"
                });
            }

            const userId =
                req.params.user_id;

            if (!userId) {
                return res.status(400).json({
                    success: false,
                    message:
                        "user_id is required"
                });
            }

            const period =
                String(
                    req.query.period || "monthly"
                ).toLowerCase();

            const format =
                String(
                    req.query.format || "excel"
                ).toLowerCase();

            const dateValue =
                req.query.date;

            const monthValue =
                req.query.month;

            if (
                !["daily", "weekly", "monthly"]
                    .includes(period)
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Invalid period. Use daily, weekly or monthly."
                });
            }

            if (
                !["pdf", "excel", "text"]
                    .includes(format)
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Invalid format. Use pdf, excel or text."
                });
            }

            const report =
                await getExportReportData(
                    userId,
                    period,
                    dateValue,
                    monthValue
                );

            const title =
                getExportReportTitle(
                    period,
                    dateValue,
                    monthValue
                );

            // -------------------------------
            // TEXT
            // -------------------------------

            if (format === "text") {

                const content =
                    createTextReport(
                        title,
                        report
                    );

                const filename =
                    `${period}-trading-report-${new Date()
                        .toISOString()
                        .slice(0, 10)}.txt`;

                res.setHeader(
                    "Content-Type",
                    "text/plain; charset=utf-8"
                );

                res.setHeader(
                    "Content-Disposition",
                    `attachment; filename="${filename}"`
                );

                return res.send(content);
            }

            // -------------------------------
            // EXCEL
            // -------------------------------

            if (format === "excel") {

                const buffer =
                    await createExcelReport(
                        title,
                        report
                    );

                const filename =
                    `${period}-trading-report-${new Date()
                        .toISOString()
                        .slice(0, 10)}.xlsx`;

                res.setHeader(
                    "Content-Type",
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                );

                res.setHeader(
                    "Content-Disposition",
                    `attachment; filename="${filename}"`
                );

                return res.end(buffer);
            }

            // -------------------------------
            // PDF
            // -------------------------------

            return createPdfReport(
                title,
                report,
                res
            );

        } catch (err) {

            console.error(
                "❌ Export report error:",
                err
            );

            if (!res.headersSent) {
                return res.status(500).json({
                    success: false,
                    message:
                        err.message ||
                        "Failed to export report"
                });
            }

            return res.end();
        }
    }
);

// =============================================
// EXPORT
// =============================================

module.exports = router;