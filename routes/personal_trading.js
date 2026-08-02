// personal_trading.js - CommonJS
const express = require('express');
const router = express.Router();

// Import database
let db;
try {
  db = require('../db.js');
  console.log('✅ Database module loaded for Personal Trading');
} catch (err) {
  console.error('❌ Failed to load db.js:', err.message);
  db = null;
}

// =============================================
// CREATE TABLE (if not exists)
// =============================================
const createTable = async () => {
  if (!db) {
    console.error('❌ Database not available');
    return;
  }
  
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS personal_trading (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        date DATE NOT NULL,
        broker VARCHAR(50) NOT NULL,
        segment VARCHAR(50) NOT NULL,
        name VARCHAR(100) NOT NULL,
        type VARCHAR(10) NOT NULL CHECK (type IN ('Buy', 'Sell')),
        quantity INTEGER NOT NULL DEFAULT 1,
        entry_price DECIMAL(15,2) NOT NULL DEFAULT 0,
        exit_price DECIMAL(15,2) NOT NULL DEFAULT 0,
        profit_loss DECIMAL(15,2) DEFAULT 0,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ personal_trading table ready');
  } catch (err) {
    console.error('❌ Table creation error:', err.message);
  }
};

createTable();

// =============================================
// 1. CREATE - Add New Trade
// =============================================
router.post('/add', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    const { 
      user_id, date, broker, segment, name, type, 
      quantity, entry_price, exit_price, profit_loss, notes 
    } = req.body;

    // Validate required fields
    if (!user_id) {
      return res.status(400).json({
        success: false,
        message: 'user_id is required'
      });
    }

    if (!name) {
      return res.status(400).json({
        success: false,
        message: 'Trade name is required'
      });
    }

    if (!date) {
      return res.status(400).json({
        success: false,
        message: 'Date is required'
      });
    }

    // Calculate profit_loss if not provided or use provided value
    let calculatedProfitLoss = profit_loss;
    if (profit_loss === undefined || profit_loss === null || profit_loss === 0) {
      calculatedProfitLoss = (parseFloat(exit_price || 0) - parseFloat(entry_price || 0)) * parseFloat(quantity || 0);
    }

    const result = await db.query(
      `INSERT INTO personal_trading (
        user_id, date, broker, segment, name, type,
        quantity, entry_price, exit_price, profit_loss, notes
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *`,
      [
        user_id, date, broker, segment, name, type,
        quantity || 1, entry_price || 0, exit_price || 0, 
        calculatedProfitLoss, notes || null
      ]
    );

    res.status(201).json({
      success: true,
      message: '✅ Trade added successfully',
      data: result.rows[0]
    });

  } catch (err) {
    console.error('❌ Add trade error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to add trade',
      error: err.message
    });
  }
});

// =============================================
// 2. UPDATE - Update Trade by ID
// =============================================
router.put('/update/:id', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    const { id } = req.params;
    const { 
      date, broker, segment, name, type, 
      quantity, entry_price, exit_price, profit_loss, notes 
    } = req.body;

    // Check if trade exists
    const existingTrade = await db.query(
      'SELECT * FROM personal_trading WHERE id = $1',
      [id]
    );

    if (existingTrade.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Trade not found'
      });
    }

    // Calculate profit_loss if not provided
    let calculatedProfitLoss = profit_loss;
    if (profit_loss === undefined || profit_loss === null) {
      calculatedProfitLoss = (parseFloat(exit_price || 0) - parseFloat(entry_price || 0)) * parseFloat(quantity || 0);
    }

    const result = await db.query(
      `UPDATE personal_trading SET
        date = $1,
        broker = $2,
        segment = $3,
        name = $4,
        type = $5,
        quantity = $6,
        entry_price = $7,
        exit_price = $8,
        profit_loss = $9,
        notes = $10,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $11
      RETURNING *`,
      [
        date, broker, segment, name, type,
        quantity || 1, entry_price || 0, exit_price || 0, 
        calculatedProfitLoss, notes || null,
        id
      ]
    );

    res.json({
      success: true,
      message: '✅ Trade updated successfully',
      data: result.rows[0]
    });

  } catch (err) {
    console.error('❌ Update trade error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to update trade',
      error: err.message
    });
  }
});

// =============================================
// 3. DELETE - Delete Trade by ID
// =============================================
router.delete('/delete/:id', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    const { id } = req.params;

    // Check if trade exists
    const existingTrade = await db.query(
      'SELECT * FROM personal_trading WHERE id = $1',
      [id]
    );

    if (existingTrade.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Trade not found'
      });
    }

    await db.query('DELETE FROM personal_trading WHERE id = $1', [id]);

    res.json({
      success: true,
      message: '✅ Trade deleted successfully',
      deletedId: parseInt(id)
    });

  } catch (err) {
    console.error('❌ Delete trade error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to delete trade',
      error: err.message
    });
  }
});

// =============================================
// 4. GET - All Trades or By User/Month
// =============================================

// Get all trades (with optional pagination)
router.get('/all', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    const { limit = 100, offset = 0 } = req.query;
    const result = await db.query(
      `SELECT * FROM personal_trading 
       ORDER BY date DESC, created_at DESC 
       LIMIT $1 OFFSET $2`,
      [parseInt(limit), parseInt(offset)]
    );

    // Get total count
    const countResult = await db.query(
      'SELECT COUNT(*) FROM personal_trading'
    );

    res.json({
      success: true,
      count: result.rows.length,
      total: parseInt(countResult.rows[0].count),
      data: result.rows
    });

  } catch (err) {
    console.error('❌ Fetch all trades error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch trades',
      error: err.message
    });
  }
});

// Get trades by user_id
router.get('/user/:user_id', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    const { user_id } = req.params;
    const result = await db.query(
      'SELECT * FROM personal_trading WHERE user_id = $1 ORDER BY date DESC, created_at DESC',
      [user_id]
    );

    res.json({
      success: true,
      count: result.rows.length,
      data: result.rows
    });

  } catch (err) {
    console.error('❌ Fetch user trades error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch trades',
      error: err.message
    });
  }
});

// Get trades by user_id and month (YYYY-MM format)
router.get('/user/:user_id/month/:month', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    const { user_id, month } = req.params;

    // Validate month format (YYYY-MM)
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid month format. Use YYYY-MM'
      });
    }

    const result = await db.query(
      `SELECT * FROM personal_trading 
       WHERE user_id = $1 
       AND TO_CHAR(date, 'YYYY-MM') = $2 
       ORDER BY date DESC, created_at DESC`,
      [user_id, month]
    );

    res.json({
      success: true,
      count: result.rows.length,
      data: result.rows
    });

  } catch (err) {
    console.error('❌ Fetch month trades error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch trades',
      error: err.message
    });
  }
});

// Get trades by user_id and month with statistics
router.get('/user/:user_id/month/:month/stats', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    const { user_id, month } = req.params;

    // Validate month format (YYYY-MM)
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid month format. Use YYYY-MM'
      });
    }

    // Get all trades for the month
    const tradesResult = await db.query(
      `SELECT * FROM personal_trading 
       WHERE user_id = $1 
       AND TO_CHAR(date, 'YYYY-MM') = $2 
       ORDER BY date DESC, created_at DESC`,
      [user_id, month]
    );

    const trades = tradesResult.rows;
    const totalTrades = trades.length;
    
    // Calculate statistics
    const winningTrades = trades.filter(t => parseFloat(t.profit_loss) > 0);
    const losingTrades = trades.filter(t => parseFloat(t.profit_loss) < 0);
    const totalProfit = winningTrades.reduce((sum, t) => sum + parseFloat(t.profit_loss), 0);
    const totalLoss = losingTrades.reduce((sum, t) => sum + Math.abs(parseFloat(t.profit_loss)), 0);
    const netProfit = totalProfit - totalLoss;
    const winRate = totalTrades > 0 ? (winningTrades.length / totalTrades) * 100 : 0;
    const avgProfit = winningTrades.length > 0 ? totalProfit / winningTrades.length : 0;
    const avgLoss = losingTrades.length > 0 ? totalLoss / losingTrades.length : 0;
    const bestTrade = winningTrades.length > 0 ? Math.max(...winningTrades.map(t => parseFloat(t.profit_loss))) : 0;
    const worstTrade = losingTrades.length > 0 ? Math.min(...losingTrades.map(t => parseFloat(t.profit_loss))) : 0;
    const profitFactor = totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? Infinity : 0;

    // Broker summary
    const brokerSummary = {};
    trades.forEach(t => {
      if (!brokerSummary[t.broker]) {
        brokerSummary[t.broker] = { trades: 0, profit: 0, loss: 0 };
      }
      brokerSummary[t.broker].trades++;
      if (parseFloat(t.profit_loss) > 0) {
        brokerSummary[t.broker].profit += parseFloat(t.profit_loss);
      } else {
        brokerSummary[t.broker].loss += Math.abs(parseFloat(t.profit_loss));
      }
    });

    // Segment summary
    const segmentSummary = {};
    trades.forEach(t => {
      if (!segmentSummary[t.segment]) {
        segmentSummary[t.segment] = { trades: 0, profit: 0, loss: 0 };
      }
      segmentSummary[t.segment].trades++;
      if (parseFloat(t.profit_loss) > 0) {
        segmentSummary[t.segment].profit += parseFloat(t.profit_loss);
      } else {
        segmentSummary[t.segment].loss += Math.abs(parseFloat(t.profit_loss));
      }
    });

    res.json({
      success: true,
      data: {
        trades,
        stats: {
          totalTrades,
          winningTrades: winningTrades.length,
          losingTrades: losingTrades.length,
          totalProfit,
          totalLoss,
          netProfit,
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
    console.error('❌ Fetch month stats error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch statistics',
      error: err.message
    });
  }
});

// Get single trade by ID
router.get('/:id', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    const { id } = req.params;
    const result = await db.query(
      'SELECT * FROM personal_trading WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Trade not found'
      });
    }

    res.json({
      success: true,
      data: result.rows[0]
    });

  } catch (err) {
    console.error('❌ Fetch trade error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch trade',
      error: err.message
    });
  }
});

// =============================================
// 5. GET - Dashboard Summary Statistics
// =============================================
router.get('/dashboard/:user_id', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    const { user_id } = req.params;

    // Get overall statistics
    const result = await db.query(
      `SELECT 
        COUNT(*) as total_trades,
        COUNT(CASE WHEN profit_loss > 0 THEN 1 END) as winning_trades,
        COUNT(CASE WHEN profit_loss < 0 THEN 1 END) as losing_trades,
        COALESCE(SUM(CASE WHEN profit_loss > 0 THEN profit_loss ELSE 0 END), 0) as total_profit,
        COALESCE(SUM(CASE WHEN profit_loss < 0 THEN ABS(profit_loss) ELSE 0 END), 0) as total_loss,
        COALESCE(SUM(profit_loss), 0) as net_profit
      FROM personal_trading 
      WHERE user_id = $1`,
      [user_id]
    );

    const stats = result.rows[0];
    const totalTrades = parseInt(stats.total_trades || 0);
    const winningTrades = parseInt(stats.winning_trades || 0);
    const totalProfit = parseFloat(stats.total_profit || 0);
    const totalLoss = parseFloat(stats.total_loss || 0);
    
    const winRate = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0;
    const profitFactor = totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? Infinity : 0;

    // Get recent trades
    const recentTrades = await db.query(
      `SELECT * FROM personal_trading 
       WHERE user_id = $1 
       ORDER BY date DESC, created_at DESC 
       LIMIT 10`,
      [user_id]
    );

    res.json({
      success: true,
      data: {
        stats: {
          totalTrades,
          winningTrades: parseInt(stats.winning_trades || 0),
          losingTrades: parseInt(stats.losing_trades || 0),
          totalProfit,
          totalLoss,
          netProfit: parseFloat(stats.net_profit || 0),
          winRate,
          profitFactor: profitFactor === Infinity ? null : profitFactor
        },
        recentTrades: recentTrades.rows
      }
    });

  } catch (err) {
    console.error('❌ Dashboard error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch dashboard data',
      error: err.message
    });
  }
});

module.exports = router;