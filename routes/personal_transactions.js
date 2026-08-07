// personal_transactions.js
const express = require('express');
const router = express.Router();

// =============================================
// IMPORT DATABASE
// =============================================
let db;
try {
  db = require('../db.js');
  console.log('✅ Database module loaded for Personal Transactions');
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
      CREATE TABLE IF NOT EXISTS Personal_transactions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES Personal_users(id) ON DELETE CASCADE,
        person_name VARCHAR(150) NOT NULL,
        amount DECIMAL(15,2) NOT NULL,
        transaction_date DATE DEFAULT CURRENT_DATE,
        type VARCHAR(10) NOT NULL CHECK (type IN ('Give','Take')),
        status VARCHAR(15) NOT NULL CHECK (status IN ('Pending','Received')),
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Personal_transactions table ready');
  } catch (err) {
    console.error('❌ Table creation error:', err.message);
  }
};

createTable();

// =============================================
// HELPER FUNCTIONS
// =============================================

// Get transaction by id
const getTransactionById = async (id) => {
  if (!db) return null;
  try {
    const result = await db.query(
      'SELECT * FROM Personal_transactions WHERE id = $1',
      [id]
    );
    return result.rows[0] || null;
  } catch (err) {
    console.error('❌ Get transaction error:', err.message);
    return null;
  }
};

// =============================================
// 1. ADD TRANSACTION
// =============================================
router.post('/', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ success: false, message: 'Database not available' });
    }

    const {
      user_id,
      person_name,
      amount,
      transaction_date,
      type,
      status,
      notes
    } = req.body;

    // Validation
    if (!user_id) {
      return res.status(400).json({ success: false, message: 'user_id is required' });
    }

    if (!person_name) {
      return res.status(400).json({ success: false, message: 'person_name is required' });
    }

    if (!amount || isNaN(amount) || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Valid amount is required' });
    }

    if (!type || !['Give', 'Take'].includes(type)) {
      return res.status(400).json({ success: false, message: 'type must be "Give" or "Take"' });
    }

    if (!status || !['Pending', 'Received'].includes(status)) {
      return res.status(400).json({ success: false, message: 'status must be "Pending" or "Received"' });
    }

    // Check if user exists
    const userCheck = await db.query(
      'SELECT id FROM Personal_users WHERE id = $1',
      [user_id]
    );

    if (userCheck.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const result = await db.query(
      `INSERT INTO Personal_transactions 
       (user_id, person_name, amount, transaction_date, type, status, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [user_id, person_name, amount, transaction_date || new Date(), type, status, notes || '']
    );

    res.status(201).json({
      success: true,
      message: '✅ Transaction added successfully',
      data: result.rows[0]
    });

  } catch (err) {
    console.error('❌ Add transaction error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// =============================================
// 2. GET ALL TRANSACTIONS
// =============================================
router.get('/:userId', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ success: false, message: 'Database not available' });
    }

    const { userId } = req.params;
    const { type, status, from_date, to_date } = req.query;

    let query = 'SELECT * FROM Personal_transactions WHERE user_id = $1';
    let params = [userId];
    let paramIndex = 2;

    if (type && ['Give', 'Take'].includes(type)) {
      query += ` AND type = $${paramIndex}`;
      params.push(type);
      paramIndex++;
    }

    if (status && ['Pending', 'Received'].includes(status)) {
      query += ` AND status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    if (from_date) {
      query += ` AND transaction_date >= $${paramIndex}`;
      params.push(from_date);
      paramIndex++;
    }

    if (to_date) {
      query += ` AND transaction_date <= $${paramIndex}`;
      params.push(to_date);
      paramIndex++;
    }

    query += ' ORDER BY transaction_date DESC, created_at DESC';

    const result = await db.query(query, params);

    res.json({
      success: true,
      count: result.rows.length,
      data: result.rows
    });

  } catch (err) {
    console.error('❌ Get transactions error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// =============================================
// 3. GET SINGLE TRANSACTION
// =============================================
router.get('/single/:id', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ success: false, message: 'Database not available' });
    }

    const { id } = req.params;

    const transaction = await getTransactionById(parseInt(id));

    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: 'Transaction not found'
      });
    }

    res.json({
      success: true,
      data: transaction
    });

  } catch (err) {
    console.error('❌ Get transaction error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// =============================================
// 4. UPDATE TRANSACTION
// =============================================
router.put('/:id', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ success: false, message: 'Database not available' });
    }

    const { id } = req.params;
    const { person_name, amount, transaction_date, type, status, notes } = req.body;

    // Check if transaction exists
    const existing = await getTransactionById(parseInt(id));

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: 'Transaction not found'
      });
    }

    // Validation
    if (amount !== undefined && (isNaN(amount) || amount <= 0)) {
      return res.status(400).json({ success: false, message: 'Valid amount is required' });
    }

    if (type !== undefined && !['Give', 'Take'].includes(type)) {
      return res.status(400).json({ success: false, message: 'type must be "Give" or "Take"' });
    }

    if (status !== undefined && !['Pending', 'Received'].includes(status)) {
      return res.status(400).json({ success: false, message: 'status must be "Pending" or "Received"' });
    }

    const result = await db.query(
      `UPDATE Personal_transactions 
       SET person_name = COALESCE($1, person_name),
           amount = COALESCE($2, amount),
           transaction_date = COALESCE($3, transaction_date),
           type = COALESCE($4, type),
           status = COALESCE($5, status),
           notes = COALESCE($6, notes),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $7
       RETURNING *`,
      [person_name, amount, transaction_date, type, status, notes, id]
    );

    res.json({
      success: true,
      message: '✅ Transaction updated successfully',
      data: result.rows[0]
    });

  } catch (err) {
    console.error('❌ Update transaction error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// =============================================
// 5. DELETE TRANSACTION
// =============================================
router.delete('/:id', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ success: false, message: 'Database not available' });
    }

    const { id } = req.params;

    // Check if transaction exists
    const existing = await getTransactionById(parseInt(id));

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: 'Transaction not found'
      });
    }

    await db.query('DELETE FROM Personal_transactions WHERE id = $1', [id]);

    res.json({
      success: true,
      message: '✅ Transaction deleted successfully',
      deletedId: parseInt(id)
    });

  } catch (err) {
    console.error('❌ Delete transaction error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// =============================================
// 6. GET SUMMARY (Dashboard Cards)
// =============================================
router.get('/summary/:userId', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ success: false, message: 'Database not available' });
    }

    const { userId } = req.params;

    // Total Pending
    const pendingResult = await db.query(
      'SELECT COALESCE(SUM(amount), 0) as total FROM Personal_transactions WHERE user_id = $1 AND status = $2',
      [userId, 'Pending']
    );

    // Total Received
    const receivedResult = await db.query(
      'SELECT COALESCE(SUM(amount), 0) as total FROM Personal_transactions WHERE user_id = $1 AND status = $2',
      [userId, 'Received']
    );

    // Give Transactions
    const giveResult = await db.query(
      'SELECT * FROM Personal_transactions WHERE user_id = $1 AND type = $2 ORDER BY transaction_date DESC',
      [userId, 'Give']
    );

    // Take Transactions
    const takeResult = await db.query(
      'SELECT * FROM Personal_transactions WHERE user_id = $1 AND type = $2 ORDER BY transaction_date DESC',
      [userId, 'Take']
    );

    // Additional Summary Stats
    const totalGive = giveResult.rows.reduce((sum, t) => sum + parseFloat(t.amount), 0);
    const totalTake = takeResult.rows.reduce((sum, t) => sum + parseFloat(t.amount), 0);
    const totalTransactions = giveResult.rows.length + takeResult.rows.length;

    // Pending Give
    const pendingGive = giveResult.rows.filter(t => t.status === 'Pending').reduce((sum, t) => sum + parseFloat(t.amount), 0);
    
    // Pending Take
    const pendingTake = takeResult.rows.filter(t => t.status === 'Pending').reduce((sum, t) => sum + parseFloat(t.amount), 0);

    // Received Give
    const receivedGive = giveResult.rows.filter(t => t.status === 'Received').reduce((sum, t) => sum + parseFloat(t.amount), 0);
    
    // Received Take
    const receivedTake = takeResult.rows.filter(t => t.status === 'Received').reduce((sum, t) => sum + parseFloat(t.amount), 0);

    res.json({
      success: true,
      data: {
        summary: {
          totalPending: parseFloat(pendingResult.rows[0]?.total || 0),
          totalReceived: parseFloat(receivedResult.rows[0]?.total || 0),
          totalGive,
          totalTake,
          totalTransactions,
          pendingGive,
          pendingTake,
          receivedGive,
          receivedTake,
          netBalance: totalTake - totalGive
        },
        transactions: {
          give: giveResult.rows,
          take: takeResult.rows
        }
      }
    });

  } catch (err) {
    console.error('❌ Get summary error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// =============================================
// 7. UPDATE STATUS (Quick Status Update)
// =============================================
router.patch('/status/:id', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ success: false, message: 'Database not available' });
    }

    const { id } = req.params;
    const { status } = req.body;

    if (!status || !['Pending', 'Received'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'status must be "Pending" or "Received"'
      });
    }

    // Check if transaction exists
    const existing = await getTransactionById(parseInt(id));

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: 'Transaction not found'
      });
    }

    const result = await db.query(
      `UPDATE Personal_transactions 
       SET status = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING *`,
      [status, id]
    );

    res.json({
      success: true,
      message: `✅ Status updated to ${status}`,
      data: result.rows[0]
    });

  } catch (err) {
    console.error('❌ Update status error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;