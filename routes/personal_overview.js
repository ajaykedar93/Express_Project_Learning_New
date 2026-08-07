// personal_overview.js - Complete API with Fixed ON CONFLICT and No month/year columns
const express = require('express');
const router = express.Router();

// =============================================
// IMPORT DATABASE
// =============================================
let db;
try {
  db = require('../db.js');
  console.log('✅ Database module loaded for Personal Overview');
} catch (err) {
  console.error('❌ Failed to load db.js:', err.message);
  db = null;
}

// =============================================
// CREATE TABLES (if not exists)
// =============================================
const createTables = async () => {
  if (!db) {
    console.error('❌ Database not available');
    return;
  }
  
  try {
    // 1. Personal_overview - with UNIQUE constraint
    await db.query(`
      CREATE TABLE IF NOT EXISTS Personal_overview (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL UNIQUE REFERENCES Personal_users(id) ON DELETE CASCADE,
        total_business INTEGER DEFAULT 0,
        total_works INTEGER DEFAULT 0,
        business_payment DECIMAL(15,2) DEFAULT 0,
        work_payment DECIMAL(15,2) DEFAULT 0,
        total_expenses DECIMAL(15,2) DEFAULT 0,
        total_borrow DECIMAL(15,2) DEFAULT 0,
        total_loans DECIMAL(15,2) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Personal_overview table ready');

    // 2. Personal_expenses
    await db.query(`
      CREATE TABLE IF NOT EXISTS Personal_expenses (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES Personal_users(id) ON DELETE CASCADE,
        category VARCHAR(100) NOT NULL,
        amount DECIMAL(15,2) NOT NULL,
        expense_date DATE DEFAULT CURRENT_DATE,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Personal_expenses table ready');

    // 3. Personal_remaining_payments
    await db.query(`
      CREATE TABLE IF NOT EXISTS Personal_remaining_payments (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES Personal_users(id) ON DELETE CASCADE,
        person_name VARCHAR(150) NOT NULL,
        amount DECIMAL(15,2) NOT NULL,
        payment_date DATE NOT NULL,
        notes TEXT,
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Personal_remaining_payments table ready');

    // 4. Personal_loans_data
    await db.query(`
      CREATE TABLE IF NOT EXISTS Personal_loans_data (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES Personal_users(id) ON DELETE CASCADE,
        name VARCHAR(150) NOT NULL,
        amount DECIMAL(15,2) NOT NULL,
        emi DECIMAL(15,2) DEFAULT 0,
        loan_date DATE DEFAULT CURRENT_DATE,
        type VARCHAR(20) NOT NULL CHECK (type IN ('Borrow','Loan')),
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Personal_loans_data table ready');

    // CREATE TABLE IF NOT EXISTS does not add columns to tables that already
    // exist. Keep older installations compatible with the totals maintained
    // by this API.
    await db.query(`
      ALTER TABLE Personal_overview
        ADD COLUMN IF NOT EXISTS total_expenses DECIMAL(15,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS total_borrow DECIMAL(15,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS total_loans DECIMAL(15,2) DEFAULT 0
    `);
    await db.query(`
      ALTER TABLE Personal_remaining_payments
        ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'pending'
    `);
    console.log('✅ Personal Overview schema migrations applied');

  } catch (err) {
    console.error('❌ Table creation error:', err.message);
  }
};

createTables();

// =============================================
// HELPER FUNCTIONS
// =============================================

// Get overview by user_id
const getOverview = async (userId) => {
  if (!db) return null;
  try {
    const result = await db.query(
      'SELECT * FROM Personal_overview WHERE user_id = $1',
      [userId]
    );
    return result.rows[0] || null;
  } catch (err) {
    console.error('❌ Get overview error:', err.message);
    return null;
  }
};

// Format date
const formatDate = (date) => {
  if (!date) return null;
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// Get date range for month
const getMonthRange = (month, year) => {
  const startDate = new Date(year, month - 1, 1);
  const endDate = new Date(year, month, 0);
  return {
    start: formatDate(startDate),
    end: formatDate(endDate)
  };
};

// Get current month/year
const getCurrentMonthYear = () => {
  const now = new Date();
  return { month: now.getMonth() + 1, year: now.getFullYear() };
};

// Update overview expenses
const updateOverviewExpenses = async (userId) => {
  try {
    const expensesResult = await db.query(
      'SELECT COALESCE(SUM(amount), 0) as total FROM Personal_expenses WHERE user_id = $1',
      [userId]
    );
    const totalExpenses = parseFloat(expensesResult.rows[0]?.total || 0);

    await db.query(
      'UPDATE Personal_overview SET total_expenses = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2',
      [totalExpenses, userId]
    );
  } catch (err) {
    console.error('❌ Update overview expenses error:', err.message);
  }
};

// Update overview loans
const updateOverviewLoans = async (userId) => {
  try {
    const loansResult = await db.query(
      `SELECT 
        COALESCE(SUM(CASE WHEN type = 'Borrow' THEN amount ELSE 0 END), 0) as total_borrow,
        COALESCE(SUM(CASE WHEN type = 'Loan' THEN amount ELSE 0 END), 0) as total_loans
       FROM Personal_loans_data 
       WHERE user_id = $1`,
      [userId]
    );

    const totalBorrow = parseFloat(loansResult.rows[0]?.total_borrow || 0);
    const totalLoans = parseFloat(loansResult.rows[0]?.total_loans || 0);

    await db.query(
      `UPDATE Personal_overview 
       SET total_borrow = $1, total_loans = $2, updated_at = CURRENT_TIMESTAMP 
       WHERE user_id = $3`,
      [totalBorrow, totalLoans, userId]
    );
  } catch (err) {
    console.error('❌ Update overview loans error:', err.message);
  }
};

// =============================================
// 1. FINANCIAL REVIEW APIs
// =============================================

// GET Financial Review
router.get('/review/:userId', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ success: false, message: 'Database not available' });
    }

    const { userId } = req.params;

    const overview = await getOverview(parseInt(userId));

    if (!overview) {
      return res.status(404).json({
        success: false,
        message: 'No financial review found'
      });
    }

    // Get total expenses
    const expensesResult = await db.query(
      'SELECT COALESCE(SUM(amount), 0) as total FROM Personal_expenses WHERE user_id = $1',
      [userId]
    );

    // Get total borrow & loans
    const loansResult = await db.query(
      `SELECT 
        COALESCE(SUM(CASE WHEN type = 'Borrow' THEN amount ELSE 0 END), 0) as total_borrow,
        COALESCE(SUM(CASE WHEN type = 'Loan' THEN amount ELSE 0 END), 0) as total_loans
       FROM Personal_loans_data 
       WHERE user_id = $1`,
      [userId]
    );

    const totalExpenses = parseFloat(expensesResult.rows[0]?.total || 0);
    const totalBorrow = parseFloat(loansResult.rows[0]?.total_borrow || 0);
    const totalLoans = parseFloat(loansResult.rows[0]?.total_loans || 0);
    const totalPayment = parseFloat(overview.business_payment || 0) + parseFloat(overview.work_payment || 0);
    const totalSavings = totalPayment - totalExpenses + totalBorrow + totalLoans;

    res.json({
      success: true,
      data: {
        id: overview.id,
        total_business: overview.total_business || 0,
        total_works: overview.total_works || 0,
        business_payment: parseFloat(overview.business_payment) || 0,
        work_payment: parseFloat(overview.work_payment) || 0,
        total_payment: totalPayment,
        total_expenses: totalExpenses,
        total_borrow: totalBorrow,
        total_loans: totalLoans,
        total_savings: totalSavings
      }
    });

  } catch (err) {
    console.error('❌ Fetch review error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// UPSERT Financial Review - FIXED (no ON CONFLICT)
router.post('/review/upsert', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ success: false, message: 'Database not available' });
    }

    const {
      user_id,
      total_business,
      total_works,
      business_payment,
      work_payment
    } = req.body;

    if (!user_id) {
      return res.status(400).json({ success: false, message: 'user_id is required' });
    }

    // Check if user exists
    const userCheck = await db.query(
      'SELECT id FROM Personal_users WHERE id = $1',
      [user_id]
    );

    if (userCheck.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Check if overview exists
    const existing = await getOverview(parseInt(user_id));

    let result;

    if (existing) {
      // UPDATE
      result = await db.query(
        `UPDATE Personal_overview 
         SET total_business = $1,
             total_works = $2,
             business_payment = $3,
             work_payment = $4,
             updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $5
         RETURNING *`,
        [total_business || 0, total_works || 0, business_payment || 0, work_payment || 0, user_id]
      );
    } else {
      // INSERT
      result = await db.query(
        `INSERT INTO Personal_overview (user_id, total_business, total_works, business_payment, work_payment)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [user_id, total_business || 0, total_works || 0, business_payment || 0, work_payment || 0]
      );
    }

    res.json({
      success: true,
      message: '✅ Financial review saved successfully',
      data: result.rows[0]
    });

  } catch (err) {
    console.error('❌ Save review error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// UPDATE Financial Review
router.put('/review/:userId', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ success: false, message: 'Database not available' });
    }

    const { userId } = req.params;
    const { total_business, total_works, business_payment, work_payment } = req.body;

    const result = await db.query(
      `UPDATE Personal_overview
       SET total_business = COALESCE($1, total_business),
           total_works = COALESCE($2, total_works),
           business_payment = COALESCE($3, business_payment),
           work_payment = COALESCE($4, work_payment),
           updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $5
       RETURNING *`,
      [total_business, total_works, business_payment, work_payment, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Financial review not found' });
    }

    res.json({
      success: true,
      message: '✅ Financial review updated successfully',
      data: result.rows[0]
    });
  } catch (err) {
    console.error('❌ Update review error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// =============================================
// 2. EXPENSES APIs
// =============================================

// GET All Expenses (with filters)
router.get('/expenses/:userId', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ success: false, message: 'Database not available' });
    }

    const { userId } = req.params;
    const { category, start_date, end_date, month, year } = req.query;

    let query = `SELECT * FROM Personal_expenses WHERE user_id = $1`;
    let params = [userId];
    let paramIndex = 2;

    // Date range filter
    if (month && year) {
      const range = getMonthRange(parseInt(month), parseInt(year));
      query += ` AND expense_date >= $${paramIndex} AND expense_date <= $${paramIndex + 1}`;
      params.push(range.start, range.end);
      paramIndex += 2;
    } else if (start_date) {
      query += ` AND expense_date >= $${paramIndex}`;
      params.push(start_date);
      paramIndex++;
    }

    if (end_date) {
      query += ` AND expense_date <= $${paramIndex}`;
      params.push(end_date);
      paramIndex++;
    }

    if (category) {
      query += ` AND category ILIKE $${paramIndex}`;
      params.push(`%${category}%`);
      paramIndex++;
    }

    query += ` ORDER BY expense_date DESC`;

    const result = await db.query(query, params);

    const totalExpenses = result.rows.reduce((sum, row) => sum + parseFloat(row.amount), 0);
    const categoryBreakdown = {};
    result.rows.forEach(row => {
      categoryBreakdown[row.category] = (categoryBreakdown[row.category] || 0) + parseFloat(row.amount);
    });

    res.json({
      success: true,
      count: result.rows.length,
      total: totalExpenses,
      categoryBreakdown,
      data: result.rows
    });

  } catch (err) {
    console.error('❌ Fetch expenses error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET Expense Pie Chart Data
router.get('/expenses/pie/:userId', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ success: false, message: 'Database not available' });
    }

    const { userId } = req.params;
    const { month, year } = req.query;

    let query = `SELECT category, SUM(amount) as total FROM Personal_expenses WHERE user_id = $1`;
    let params = [userId];
    let paramIndex = 2;

    if (month && year) {
      const range = getMonthRange(parseInt(month), parseInt(year));
      query += ` AND expense_date >= $${paramIndex} AND expense_date <= $${paramIndex + 1}`;
      params.push(range.start, range.end);
      paramIndex += 2;
    }

    query += ` GROUP BY category ORDER BY total DESC`;

    const result = await db.query(query, params);

    const colors = ['#F59E0B', '#10B981', '#7C3AED', '#4F6BFF', '#2EA8FF', '#F43F5E', '#8B5CF6'];
    
    const pieData = result.rows.map((row, index) => ({
      category: row.category,
      amount: parseFloat(row.total),
      color: colors[index % colors.length],
      percentage: 0
    }));

    const total = pieData.reduce((sum, item) => sum + item.amount, 0);
    pieData.forEach(item => {
      item.percentage = total > 0 ? Math.round((item.amount / total) * 100) : 0;
    });

    res.json({
      success: true,
      total,
      data: pieData
    });

  } catch (err) {
    console.error('❌ Fetch expense pie error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ADD Expense - FIXED (no month/year)
router.post('/expenses/add', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ success: false, message: 'Database not available' });
    }

    const {
      user_id,
      category,
      amount,
      expense_date,
      notes
    } = req.body;

    if (!user_id || !category || !amount) {
      return res.status(400).json({ success: false, message: 'user_id, category, and amount are required' });
    }

    const result = await db.query(
      `INSERT INTO Personal_expenses (user_id, category, amount, expense_date, notes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [user_id, category, amount, expense_date || new Date(), notes || '']
    );

    // Update total_expenses in overview
    await updateOverviewExpenses(user_id);

    res.status(201).json({
      success: true,
      message: '✅ Expense added successfully',
      data: result.rows[0]
    });

  } catch (err) {
    console.error('❌ Add expense error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// UPDATE Expense
router.put('/expenses/update/:id', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ success: false, message: 'Database not available' });
    }

    const { id } = req.params;
    const { category, amount, expense_date, notes } = req.body;

    // Get user_id before update
    const oldExpense = await db.query(
      'SELECT user_id FROM Personal_expenses WHERE id = $1',
      [id]
    );

    const result = await db.query(
      `UPDATE Personal_expenses 
       SET category = COALESCE($1, category),
           amount = COALESCE($2, amount),
           expense_date = COALESCE($3, expense_date),
           notes = COALESCE($4, notes)
       WHERE id = $5
       RETURNING *`,
      [category, amount, expense_date, notes, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Expense not found' });
    }

    // Update total_expenses in overview
    if (oldExpense.rows.length > 0) {
      await updateOverviewExpenses(oldExpense.rows[0].user_id);
    }

    res.json({
      success: true,
      message: '✅ Expense updated successfully',
      data: result.rows[0]
    });

  } catch (err) {
    console.error('❌ Update expense error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE Expense
router.delete('/expenses/delete/:id', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ success: false, message: 'Database not available' });
    }

    const { id } = req.params;

    // Get user_id before delete
    const oldExpense = await db.query(
      'SELECT user_id FROM Personal_expenses WHERE id = $1',
      [id]
    );

    const result = await db.query(
      'DELETE FROM Personal_expenses WHERE id = $1 RETURNING *',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Expense not found' });
    }

    // Update total_expenses in overview
    if (oldExpense.rows.length > 0) {
      await updateOverviewExpenses(oldExpense.rows[0].user_id);
    }

    res.json({
      success: true,
      message: '✅ Expense deleted successfully',
      data: result.rows[0]
    });

  } catch (err) {
    console.error('❌ Delete expense error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// =============================================
// 3. LOANS & BORROW APIs
// =============================================

// GET All Loans/Borrows
router.get('/loans/:userId', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ success: false, message: 'Database not available' });
    }

    const { userId } = req.params;
    const { type, month, year } = req.query;

    let query = `SELECT * FROM Personal_loans_data WHERE user_id = $1`;
    let params = [userId];
    let paramIndex = 2;

    if (month && year) {
      const range = getMonthRange(parseInt(month), parseInt(year));
      query += ` AND loan_date >= $${paramIndex} AND loan_date <= $${paramIndex + 1}`;
      params.push(range.start, range.end);
      paramIndex += 2;
    }

    if (type) {
      query += ` AND type = $${paramIndex}`;
      params.push(type);
      paramIndex++;
    }

    query += ` ORDER BY loan_date DESC`;

    const result = await db.query(query, params);

    const totalBorrow = result.rows
      .filter(row => row.type === 'Borrow')
      .reduce((sum, row) => sum + parseFloat(row.amount), 0);
    
    const totalLoans = result.rows
      .filter(row => row.type === 'Loan')
      .reduce((sum, row) => sum + parseFloat(row.amount), 0);

    res.json({
      success: true,
      count: result.rows.length,
      totalBorrow,
      totalLoans,
      data: result.rows
    });

  } catch (err) {
    console.error('❌ Fetch loans error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ADD Loan/Borrow - FIXED (no month/year)
router.post('/loans/add', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ success: false, message: 'Database not available' });
    }

    const {
      user_id,
      name,
      amount,
      emi,
      loan_date,
      type,
      notes
    } = req.body;

    if (!user_id || !name || !amount || !type) {
      return res.status(400).json({ 
        success: false, 
        message: 'user_id, name, amount, and type are required' 
      });
    }

    if (!['Borrow', 'Loan'].includes(type)) {
      return res.status(400).json({ 
        success: false, 
        message: 'type must be "Borrow" or "Loan"' 
      });
    }

    const result = await db.query(
      `INSERT INTO Personal_loans_data (user_id, name, amount, emi, loan_date, type, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [user_id, name, amount, emi || 0, loan_date || new Date(), type, notes || '']
    );

    // Update overview totals
    await updateOverviewLoans(user_id);

    res.status(201).json({
      success: true,
      message: `✅ ${type} added successfully`,
      data: result.rows[0]
    });

  } catch (err) {
    console.error('❌ Add loan error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// UPDATE Loan/Borrow
router.put('/loans/update/:id', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ success: false, message: 'Database not available' });
    }

    const { id } = req.params;
    const { name, amount, emi, loan_date, type, notes } = req.body;

    // Get user_id before update
    const oldLoan = await db.query(
      'SELECT user_id FROM Personal_loans_data WHERE id = $1',
      [id]
    );

    const result = await db.query(
      `UPDATE Personal_loans_data 
       SET name = COALESCE($1, name),
           amount = COALESCE($2, amount),
           emi = COALESCE($3, emi),
           loan_date = COALESCE($4, loan_date),
           type = COALESCE($5, type),
           notes = COALESCE($6, notes)
       WHERE id = $7
       RETURNING *`,
      [name, amount, emi, loan_date, type, notes, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Loan record not found' });
    }

    if (oldLoan.rows.length > 0) {
      await updateOverviewLoans(oldLoan.rows[0].user_id);
    }

    res.json({
      success: true,
      message: '✅ Loan record updated successfully',
      data: result.rows[0]
    });

  } catch (err) {
    console.error('❌ Update loan error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE Loan/Borrow
router.delete('/loans/delete/:id', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ success: false, message: 'Database not available' });
    }

    const { id } = req.params;

    // Get user_id before delete
    const oldLoan = await db.query(
      'SELECT user_id FROM Personal_loans_data WHERE id = $1',
      [id]
    );

    const result = await db.query(
      'DELETE FROM Personal_loans_data WHERE id = $1 RETURNING *',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Loan record not found' });
    }

    if (oldLoan.rows.length > 0) {
      await updateOverviewLoans(oldLoan.rows[0].user_id);
    }

    res.json({
      success: true,
      message: '✅ Loan record deleted successfully',
      data: result.rows[0]
    });

  } catch (err) {
    console.error('❌ Delete loan error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// =============================================
// 4. REMAINING PAYMENTS APIs
// =============================================

// GET All Remaining Payments
router.get('/payments/:userId', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ success: false, message: 'Database not available' });
    }

    const { userId } = req.params;
    const { status, month, year } = req.query;

    let query = `SELECT * FROM Personal_remaining_payments WHERE user_id = $1`;
    let params = [userId];
    let paramIndex = 2;

    if (month && year) {
      const range = getMonthRange(parseInt(month), parseInt(year));
      query += ` AND payment_date >= $${paramIndex} AND payment_date <= $${paramIndex + 1}`;
      params.push(range.start, range.end);
      paramIndex += 2;
    }

    if (status) {
      query += ` AND status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    query += ` ORDER BY payment_date DESC`;

    const result = await db.query(query, params);

    const totalPending = result.rows
      .filter(row => row.status === 'pending')
      .reduce((sum, row) => sum + parseFloat(row.amount), 0);

    res.json({
      success: true,
      count: result.rows.length,
      totalPending,
      data: result.rows
    });

  } catch (err) {
    console.error('❌ Fetch payments error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ADD Remaining Payment - FIXED (no month/year)
router.post('/payments/add', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ success: false, message: 'Database not available' });
    }

    const {
      user_id,
      person_name,
      amount,
      payment_date,
      notes,
      status
    } = req.body;

    if (!user_id || !person_name || !amount) {
      return res.status(400).json({ 
        success: false, 
        message: 'user_id, person_name, and amount are required' 
      });
    }

    const result = await db.query(
      `INSERT INTO Personal_remaining_payments (user_id, person_name, amount, payment_date, notes, status)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [user_id, person_name, amount, payment_date || new Date(), notes || '', status || 'pending']
    );

    res.status(201).json({
      success: true,
      message: '✅ Payment record added successfully',
      data: result.rows[0]
    });

  } catch (err) {
    console.error('❌ Add payment error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// UPDATE Remaining Payment
router.put('/payments/update/:id', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ success: false, message: 'Database not available' });
    }

    const { id } = req.params;
    const { person_name, amount, payment_date, notes, status } = req.body;

    if (status !== undefined && !['pending', 'received', 'overdue'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'status must be "pending", "received", or "overdue"'
      });
    }

    const result = await db.query(
      `UPDATE Personal_remaining_payments
       SET person_name = COALESCE($1, person_name),
           amount = COALESCE($2, amount),
           payment_date = COALESCE($3, payment_date),
           notes = COALESCE($4, notes),
           status = COALESCE($5, status)
       WHERE id = $6
       RETURNING *`,
      [person_name, amount, payment_date, notes, status, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Payment record not found' });
    }

    res.json({
      success: true,
      message: '✅ Payment record updated successfully',
      data: result.rows[0]
    });
  } catch (err) {
    console.error('❌ Update payment error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// UPDATE Payment Status
router.put('/payments/status/:id', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ success: false, message: 'Database not available' });
    }

    const { id } = req.params;
    const { status } = req.body;

    if (!status || !['pending', 'received', 'overdue'].includes(status)) {
      return res.status(400).json({ 
        success: false, 
        message: 'status must be "pending", "received", or "overdue"' 
      });
    }

    const result = await db.query(
      `UPDATE Personal_remaining_payments 
       SET status = $1
       WHERE id = $2
       RETURNING *`,
      [status, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Payment record not found' });
    }

    res.json({
      success: true,
      message: '✅ Payment status updated successfully',
      data: result.rows[0]
    });

  } catch (err) {
    console.error('❌ Update payment status error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE Payment
router.delete('/payments/delete/:id', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ success: false, message: 'Database not available' });
    }

    const { id } = req.params;

    const result = await db.query(
      'DELETE FROM Personal_remaining_payments WHERE id = $1 RETURNING *',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Payment record not found' });
    }

    res.json({
      success: true,
      message: '✅ Payment record deleted successfully',
      data: result.rows[0]
    });

  } catch (err) {
    console.error('❌ Delete payment error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// =============================================
// 5. WEEKLY PERFORMANCE API
// =============================================

router.get('/performance/weekly/:userId', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ success: false, message: 'Database not available' });
    }

    const { userId } = req.params;
    const { week_start, week_end } = req.query;

    // Parse YYYY-MM-DD as a local calendar date, avoiding timezone shifts
    // caused by `new Date('YYYY-MM-DD')` in some server timezones.
    const parseWeekDate = (value) => {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return null;
      }

      const [year, month, day] = value.split('-').map(Number);
      const date = new Date(year, month - 1, day);
      return date.getFullYear() === year
        && date.getMonth() === month - 1
        && date.getDate() === day
        ? date
        : null;
    };

    const requestedStartDate = week_start ? parseWeekDate(week_start) : null;
    const requestedEndDate = week_end ? parseWeekDate(week_end) : null;

    if ((week_start && !requestedStartDate) || (week_end && !requestedEndDate)) {
      return res.status(400).json({
        success: false,
        message: 'week_start and week_end must use YYYY-MM-DD format'
      });
    }

    let startDate;
    let endDate;
    if (requestedStartDate && requestedEndDate) {
      startDate = requestedStartDate;
      endDate = requestedEndDate;
    } else if (requestedStartDate) {
      startDate = requestedStartDate;
      endDate = new Date(startDate);
      endDate.setDate(endDate.getDate() + 6);
    } else if (requestedEndDate) {
      endDate = requestedEndDate;
      startDate = new Date(endDate);
      startDate.setDate(startDate.getDate() - 6);
    } else {
      startDate = new Date();
      startDate.setHours(0, 0, 0, 0);
      startDate.setDate(startDate.getDate() - startDate.getDay());
      endDate = new Date(startDate);
      endDate.setDate(endDate.getDate() + 6);
    }

    if (startDate > endDate) {
      return res.status(400).json({
        success: false,
        message: 'week_start must be on or before week_end'
      });
    }

    const overview = await getOverview(parseInt(userId));

    const expensesResult = await db.query(
      `SELECT * FROM Personal_expenses 
       WHERE user_id = $1 
       AND expense_date >= $2 
       AND expense_date <= $3
       ORDER BY expense_date`,
      [userId, formatDate(startDate), formatDate(endDate)]
    );

    const expenses = expensesResult.rows;

    const dailyData = {};
    for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
      const dateStr = formatDate(d);
      dailyData[dateStr] = {
        date: dateStr,
        day: d.toLocaleDateString('en-US', { weekday: 'long' }),
        income: 0,
        expenses: 0,
        savings: 0
      };
    }

    expenses.forEach(exp => {
      const dateStr = formatDate(exp.expense_date);
      if (dailyData[dateStr]) {
        dailyData[dateStr].expenses += parseFloat(exp.amount);
      }
    });

    const totalIncome = (parseFloat(overview?.business_payment) || 0) + (parseFloat(overview?.work_payment) || 0);
    const selectedDayCount = Math.round((endDate - startDate) / (1000 * 60 * 60 * 24)) + 1;
    const dailyIncome = totalIncome / selectedDayCount;
    Object.keys(dailyData).forEach(date => {
      dailyData[date].income = dailyIncome;
      dailyData[date].savings = dailyData[date].income - dailyData[date].expenses;
    });

    const dataArray = Object.values(dailyData);
    const highestExpenseDay = dataArray.reduce((max, day) => day.expenses > max.expenses ? day : max, dataArray[0]);
    const highestIncomeDay = dataArray.reduce((max, day) => day.income > max.income ? day : max, dataArray[0]);
    const maxSavingsDay = dataArray.reduce((max, day) => day.savings > max.savings ? day : max, dataArray[0]);

    const categoryTotals = {};
    expenses.forEach(exp => {
      categoryTotals[exp.category] = (categoryTotals[exp.category] || 0) + parseFloat(exp.amount);
    });

    const colors = ['#F59E0B', '#10B981', '#7C3AED', '#4F6BFF', '#2EA8FF', '#F43F5E', '#8B5CF6'];
    const pieData = Object.keys(categoryTotals).map((cat, index) => ({
      category: cat,
      amount: categoryTotals[cat],
      color: colors[index % colors.length]
    }));

    const totalExpenses = dataArray.reduce((sum, day) => sum + day.expenses, 0);
    const totalSavings = dataArray.reduce((sum, day) => sum + day.savings, 0);

    res.json({
      success: true,
      data: {
        week_start: formatDate(startDate),
        week_end: formatDate(endDate),
        totalIncome,
        totalExpenses,
        totalSavings,
        dailyData: dataArray,
        highestExpenseDay,
        highestIncomeDay,
        maxSavingsDay,
        pieData
      }
    });

  } catch (err) {
    console.error('❌ Weekly performance error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// =============================================
// 6. MONTHLY PERFORMANCE API
// =============================================

router.get('/performance/monthly/:userId', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ success: false, message: 'Database not available' });
    }

    const { userId } = req.params;
    const { month, year } = req.query;

    const current = getCurrentMonthYear();
    const targetMonth = month ? parseInt(month) : current.month;
    const targetYear = year ? parseInt(year) : current.year;

    const range = getMonthRange(targetMonth, targetYear);

    const overview = await getOverview(parseInt(userId));

    const expensesResult = await db.query(
      `SELECT * FROM Personal_expenses 
       WHERE user_id = $1 
       AND expense_date >= $2 
       AND expense_date <= $3
       ORDER BY expense_date`,
      [userId, range.start, range.end]
    );

    const loansResult = await db.query(
      `SELECT * FROM Personal_loans_data 
       WHERE user_id = $1 
       AND loan_date >= $2 
       AND loan_date <= $3`,
      [userId, range.start, range.end]
    );

    const expenses = expensesResult.rows;
    const loans = loansResult.rows;

    const totalIncome = (parseFloat(overview?.business_payment) || 0) + (parseFloat(overview?.work_payment) || 0);
    const totalExpenses = expenses.reduce((sum, exp) => sum + parseFloat(exp.amount), 0);
    const totalBorrow = loans.filter(l => l.type === 'Borrow').reduce((sum, l) => sum + parseFloat(l.amount), 0);
    const totalLoans = loans.filter(l => l.type === 'Loan').reduce((sum, l) => sum + parseFloat(l.amount), 0);
    const netProfit = totalIncome - totalExpenses;
    const totalSavings = totalIncome - totalExpenses + totalBorrow + totalLoans;

    const categoryTotals = {};
    expenses.forEach(exp => {
      categoryTotals[exp.category] = (categoryTotals[exp.category] || 0) + parseFloat(exp.amount);
    });

    const colors = ['#F59E0B', '#10B981', '#7C3AED', '#4F6BFF', '#2EA8FF', '#F43F5E', '#8B5CF6'];
    const pieData = Object.keys(categoryTotals).map((cat, index) => ({
      category: cat,
      amount: categoryTotals[cat],
      color: colors[index % colors.length],
      percentage: totalExpenses > 0 ? Math.round((categoryTotals[cat] / totalExpenses) * 100) : 0
    }));

    const incomeVsExpense = {
      totalIncome,
      totalExpenses,
      netProfit,
      profitMargin: totalIncome > 0 ? Math.round((netProfit / totalIncome) * 100) : 0,
      isProfitable: netProfit > 0
    };

    res.json({
      success: true,
      data: {
        month: targetMonth,
        year: targetYear,
        monthName: new Date(targetYear, targetMonth - 1).toLocaleString('default', { month: 'long' }),
        totalIncome,
        totalExpenses,
        totalBorrow,
        totalLoans,
        totalSavings,
        netProfit,
        pieData,
        incomeVsExpense,
        loans,
        expenseCount: expenses.length
      }
    });

  } catch (err) {
    console.error('❌ Monthly performance error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// =============================================
// 7. SUMMARY API (All Time)
// =============================================

router.get('/summary/:userId', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ success: false, message: 'Database not available' });
    }

    const { userId } = req.params;

    const overview = await getOverview(parseInt(userId));

    const expensesResult = await db.query(
      `SELECT * FROM Personal_expenses WHERE user_id = $1`,
      [userId]
    );

    const loansResult = await db.query(
      `SELECT * FROM Personal_loans_data WHERE user_id = $1`,
      [userId]
    );

    const paymentsResult = await db.query(
      `SELECT * FROM Personal_remaining_payments WHERE user_id = $1`,
      [userId]
    );

    const expenses = expensesResult.rows;
    const loans = loansResult.rows;
    const payments = paymentsResult.rows;

    const totalBusiness = overview?.total_business || 0;
    const totalWorks = overview?.total_works || 0;
    const totalBusinessPayment = parseFloat(overview?.business_payment || 0);
    const totalWorkPayment = parseFloat(overview?.work_payment || 0);
    const totalIncome = totalBusinessPayment + totalWorkPayment;
    const totalExpenses = expenses.reduce((sum, exp) => sum + parseFloat(exp.amount || 0), 0);
    const totalBorrow = loans.filter(l => l.type === 'Borrow').reduce((sum, l) => sum + parseFloat(l.amount || 0), 0);
    const totalLoans = loans.filter(l => l.type === 'Loan').reduce((sum, l) => sum + parseFloat(l.amount || 0), 0);
    const netProfit = totalIncome - totalExpenses;
    const totalSavings = totalIncome - totalExpenses + totalBorrow + totalLoans;
    const totalPendingPayments = payments.filter(p => p.status === 'pending').reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);

    const categoryTotals = {};
    expenses.forEach(exp => {
      categoryTotals[exp.category] = (categoryTotals[exp.category] || 0) + parseFloat(exp.amount);
    });

    const colors = ['#F59E0B', '#10B981', '#7C3AED', '#4F6BFF', '#2EA8FF', '#F43F5E', '#8B5CF6'];
    const pieData = Object.keys(categoryTotals).map((cat, index) => ({
      category: cat,
      amount: categoryTotals[cat],
      color: colors[index % colors.length],
      percentage: totalExpenses > 0 ? Math.round((categoryTotals[cat] / totalExpenses) * 100) : 0
    }));

    // Monthly trends - calculate from expenses grouped by month
    const monthlyTrends = {};
    expenses.forEach(exp => {
      const date = new Date(exp.expense_date);
      const key = `${date.getFullYear()}-${date.getMonth() + 1}`;
      if (!monthlyTrends[key]) {
        monthlyTrends[key] = { month: date.getMonth() + 1, year: date.getFullYear(), expenses: 0, income: 0 };
      }
      monthlyTrends[key].expenses += parseFloat(exp.amount);
    });

    // Add income to monthly trends
    const overviewsResult = await db.query(
      'SELECT * FROM Personal_overview WHERE user_id = $1',
      [userId]
    );
    overviewsResult.rows.forEach(ov => {
      const key = `${new Date().getFullYear()}-${new Date().getMonth() + 1}`;
      if (monthlyTrends[key]) {
        monthlyTrends[key].income = parseFloat(ov.business_payment || 0) + parseFloat(ov.work_payment || 0);
        monthlyTrends[key].savings = monthlyTrends[key].income - monthlyTrends[key].expenses;
      }
    });

    const monthlyTrendsArray = Object.keys(monthlyTrends).map(key => ({
      monthName: new Date(monthlyTrends[key].year, monthlyTrends[key].month - 1).toLocaleString('default', { month: 'short' }),
      year: monthlyTrends[key].year,
      income: monthlyTrends[key].income || 0,
      expenses: monthlyTrends[key].expenses || 0,
      savings: (monthlyTrends[key].income || 0) - (monthlyTrends[key].expenses || 0)
    }));

    res.json({
      success: true,
      data: {
        summary: {
          totalBusiness,
          totalWorks,
          totalBusinessPayment,
          totalWorkPayment,
          totalIncome,
          totalExpenses,
          totalBorrow,
          totalLoans,
          totalSavings,
          netProfit,
          totalPendingPayments,
          profitMargin: totalIncome > 0 ? Math.round((netProfit / totalIncome) * 100) : 0
        },
        pieData,
        monthlyTrends: monthlyTrendsArray,
        recentExpenses: expenses.slice(0, 10),
        recentLoans: loans.slice(0, 10),
        pendingPayments: payments.filter(p => p.status === 'pending')
      }
    });

  } catch (err) {
    console.error('❌ Summary error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// =============================================
// 8. SUMMARY PIE CHART
// =============================================

router.get('/summary/pie/:userId', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ success: false, message: 'Database not available' });
    }

    const { userId } = req.params;
    const { type } = req.query;

    const colors = ['#10B981', '#F43F5E', '#F59E0B', '#7C3AED', '#4F6BFF'];
    
    if (type === 'expenses') {
      const result = await db.query(
        `SELECT category, SUM(amount) as total
         FROM Personal_expenses
         WHERE user_id = $1
         GROUP BY category
         ORDER BY total DESC`,
        [userId]
      );
      
      const pieData = result.rows.map((row, index) => ({
        label: row.category,
        amount: parseFloat(row.total || 0),
        color: colors[index % colors.length]
      }));
      
      return res.json({ success: true, data: pieData });
      
    } else if (type === 'income') {
      const overview = await getOverview(parseInt(userId));
      const pieData = [
        { label: 'Business Payment', amount: parseFloat(overview?.business_payment || 0), color: colors[0] },
        { label: 'Work Payment', amount: parseFloat(overview?.work_payment || 0), color: colors[1] }
      ];
      return res.json({ success: true, data: pieData });
      
    } else {
      // All: Income, Expenses, Savings
      const overview = await getOverview(parseInt(userId));
      const expensesResult = await db.query(
        'SELECT COALESCE(SUM(amount), 0) as total FROM Personal_expenses WHERE user_id = $1',
        [userId]
      );
      const loansResult = await db.query(
        `SELECT 
          COALESCE(SUM(CASE WHEN type = 'Borrow' THEN amount ELSE 0 END), 0) as borrow,
          COALESCE(SUM(CASE WHEN type = 'Loan' THEN amount ELSE 0 END), 0) as loans
         FROM Personal_loans_data 
         WHERE user_id = $1`,
        [userId]
      );
      
      const income = parseFloat(overview?.business_payment || 0) + parseFloat(overview?.work_payment || 0);
      const expenses = parseFloat(expensesResult.rows[0]?.total || 0);
      const borrow = parseFloat(loansResult.rows[0]?.borrow || 0);
      const loans = parseFloat(loansResult.rows[0]?.loans || 0);
      const savings = income - expenses + borrow + loans;
      
      const pieData = [
        { label: 'Income', amount: income, color: colors[0] },
        { label: 'Expenses', amount: expenses, color: colors[1] },
        { label: 'Savings', amount: savings, color: colors[2] }
      ];
      
      return res.json({ success: true, data: pieData });
    }

  } catch (err) {
    console.error('❌ Summary pie error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// =============================================
// 9. SEARCH APIs
// =============================================

router.get('/search/expenses/:userId', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ success: false, message: 'Database not available' });
    }

    const { userId } = req.params;
    const { q, category, from_date, to_date, min_amount, max_amount } = req.query;

    let query = `SELECT * FROM Personal_expenses WHERE user_id = $1`;
    let params = [userId];
    let paramIndex = 2;

    if (q) {
      query += ` AND (category ILIKE $${paramIndex} OR notes ILIKE $${paramIndex})`;
      params.push(`%${q}%`);
      paramIndex++;
    }

    if (category) {
      query += ` AND category ILIKE $${paramIndex}`;
      params.push(`%${category}%`);
      paramIndex++;
    }

    if (from_date) {
      query += ` AND expense_date >= $${paramIndex}`;
      params.push(from_date);
      paramIndex++;
    }

    if (to_date) {
      query += ` AND expense_date <= $${paramIndex}`;
      params.push(to_date);
      paramIndex++;
    }

    if (min_amount) {
      query += ` AND amount >= $${paramIndex}`;
      params.push(parseFloat(min_amount));
      paramIndex++;
    }

    if (max_amount) {
      query += ` AND amount <= $${paramIndex}`;
      params.push(parseFloat(max_amount));
      paramIndex++;
    }

    query += ` ORDER BY expense_date DESC`;

    const result = await db.query(query, params);

    res.json({
      success: true,
      count: result.rows.length,
      data: result.rows
    });

  } catch (err) {
    console.error('❌ Search expenses error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// =============================================
// 10. RECALCULATE ALL TOTALS
// =============================================

router.post('/recalculate/:userId', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ success: false, message: 'Database not available' });
    }

    const { userId } = req.params;

    // Update expenses
    await updateOverviewExpenses(userId);

    // Update loans
    await updateOverviewLoans(userId);

    res.json({
      success: true,
      message: '✅ All totals recalculated successfully'
    });

  } catch (err) {
    console.error('❌ Recalculate error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// =============================================
// EXPORT ROUTER
// =============================================
module.exports = router;
