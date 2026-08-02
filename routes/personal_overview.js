// personal_overview.js - Converted to CommonJS
const express = require('express');
const router = express.Router();

// Import database with proper error handling
let db;
try {
  db = require('../db.js');
  console.log('✅ Database module loaded for Personal Overview');
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
      CREATE TABLE IF NOT EXISTS Personal_overview (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL UNIQUE,
        
        -- Financial Review
        total_business INTEGER DEFAULT 0,
        total_works INTEGER DEFAULT 0,
        total_business_payment NUMERIC(15,2) DEFAULT 0,
        total_work_payment NUMERIC(15,2) DEFAULT 0,
        
        -- Payment & Expenses
        total_payment NUMERIC(15,2) DEFAULT 0,
        total_expenses NUMERIC(15,2) DEFAULT 0,
        petrol_expense NUMERIC(15,2) DEFAULT 0,
        other_expense NUMERIC(15,2) DEFAULT 0,
        
        -- Borrow & Loans
        total_borrow NUMERIC(15,2) DEFAULT 0,
        total_loans NUMERIC(15,2) DEFAULT 0,
        total_savings NUMERIC(15,2) DEFAULT 0,
        remaining_payment NUMERIC(15,2) DEFAULT 0,
        
        -- Portfolio
        stocks NUMERIC(15,2) DEFAULT 0,
        mutual_funds NUMERIC(15,2) DEFAULT 0,
        fixed_deposit NUMERIC(15,2) DEFAULT 0,
        real_estate NUMERIC(15,2) DEFAULT 0,
        crypto NUMERIC(15,2) DEFAULT 0,
        
        -- Weekly Performance
        monday DECIMAL(5,2) DEFAULT 0,
        tuesday DECIMAL(5,2) DEFAULT 0,
        wednesday DECIMAL(5,2) DEFAULT 0,
        thursday DECIMAL(5,2) DEFAULT 0,
        friday DECIMAL(5,2) DEFAULT 0,
        saturday DECIMAL(5,2) DEFAULT 0,
        sunday DECIMAL(5,2) DEFAULT 0,
        
        -- JSON Fields
        month_year VARCHAR(20) DEFAULT 'July 2024',
        monthly_expenses JSONB DEFAULT '{}'::jsonb,
        transactions_data JSONB DEFAULT '[]'::jsonb,
        loans_data JSONB DEFAULT '[]'::jsonb,
        products_data JSONB DEFAULT '[]'::jsonb,
        top_performers JSONB DEFAULT '{}'::jsonb,
        
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        
        CONSTRAINT fk_personal_overview_user
          FOREIGN KEY (user_id)
          REFERENCES Personal_users(id)
          ON DELETE CASCADE
      )
    `);
    console.log('✅ Personal_overview table ready');
  } catch (err) {
    console.error('❌ Table creation error:', err.message);
  }
};

createTable();

// =============================================
// HELPER: Get overview by user_id
// =============================================
const getOverviewByUserId = async (userId) => {
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

// =============================================
// 1. CREATE (POST) - Add New Overview
// =============================================
router.post('/add', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }
    
    const { user_id } = req.body;
    
    if (!user_id) {
      return res.status(400).json({
        success: false,
        message: 'user_id is required'
      });
    }
    
    // Check if user exists
    const userCheck = await db.query(
      'SELECT id FROM Personal_users WHERE id = $1',
      [user_id]
    );
    
    if (userCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    // Check if overview already exists for this user
    const existingOverview = await getOverviewByUserId(user_id);
    if (existingOverview) {
      return res.status(400).json({
        success: false,
        message: 'Overview already exists for this user. Use update instead.'
      });
    }
    
    const {
      total_business = 0,
      total_works = 0,
      total_business_payment = 0,
      total_work_payment = 0,
      total_payment = 0,
      total_expenses = 0,
      petrol_expense = 0,
      other_expense = 0,
      total_borrow = 0,
      total_loans = 0,
      total_savings = 0,
      remaining_payment = 0,
      stocks = 0,
      mutual_funds = 0,
      fixed_deposit = 0,
      real_estate = 0,
      crypto = 0,
      monday = 0,
      tuesday = 0,
      wednesday = 0,
      thursday = 0,
      friday = 0,
      saturday = 0,
      sunday = 0,
      month_year = 'July 2024',
      monthly_expenses = '{}',
      transactions_data = '[]',
      loans_data = '[]',
      products_data = '[]',
      top_performers = '{}'
    } = req.body;
    
    const result = await db.query(
      `INSERT INTO Personal_overview (
        user_id,
        total_business, total_works, total_business_payment, total_work_payment,
        total_payment, total_expenses, petrol_expense, other_expense,
        total_borrow, total_loans, total_savings, remaining_payment,
        stocks, mutual_funds, fixed_deposit, real_estate, crypto,
        monday, tuesday, wednesday, thursday, friday, saturday, sunday,
        month_year, monthly_expenses, transactions_data, loans_data, products_data, top_performers
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31)
      RETURNING *`,
      [
        user_id,
        total_business, total_works, total_business_payment, total_work_payment,
        total_payment, total_expenses, petrol_expense, other_expense,
        total_borrow, total_loans, total_savings, remaining_payment,
        stocks, mutual_funds, fixed_deposit, real_estate, crypto,
        monday, tuesday, wednesday, thursday, friday, saturday, sunday,
        month_year, monthly_expenses, transactions_data, loans_data, products_data, top_performers
      ]
    );
    
    const overview = result.rows[0];
    
    res.status(201).json({
      success: true,
      message: '✅ Overview created successfully',
      data: overview
    });
    
  } catch (err) {
    console.error('❌ Create overview error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to create overview',
      error: err.message
    });
  }
});

// =============================================
// 2. UPDATE (PUT) - Update Overview by ID
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
    
    // Check if overview exists
    const existingOverview = await db.query(
      'SELECT * FROM Personal_overview WHERE id = $1',
      [id]
    );
    
    if (existingOverview.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Overview not found'
      });
    }
    
    const oldData = existingOverview.rows[0];
    
    const {
      total_business = oldData.total_business,
      total_works = oldData.total_works,
      total_business_payment = oldData.total_business_payment,
      total_work_payment = oldData.total_work_payment,
      total_payment = oldData.total_payment,
      total_expenses = oldData.total_expenses,
      petrol_expense = oldData.petrol_expense,
      other_expense = oldData.other_expense,
      total_borrow = oldData.total_borrow,
      total_loans = oldData.total_loans,
      total_savings = oldData.total_savings,
      remaining_payment = oldData.remaining_payment,
      stocks = oldData.stocks,
      mutual_funds = oldData.mutual_funds,
      fixed_deposit = oldData.fixed_deposit,
      real_estate = oldData.real_estate,
      crypto = oldData.crypto,
      monday = oldData.monday,
      tuesday = oldData.tuesday,
      wednesday = oldData.wednesday,
      thursday = oldData.thursday,
      friday = oldData.friday,
      saturday = oldData.saturday,
      sunday = oldData.sunday,
      month_year = oldData.month_year,
      monthly_expenses = oldData.monthly_expenses,
      transactions_data = oldData.transactions_data,
      loans_data = oldData.loans_data,
      products_data = oldData.products_data,
      top_performers = oldData.top_performers
    } = req.body;
    
    const result = await db.query(
      `UPDATE Personal_overview SET
        total_business = $1,
        total_works = $2,
        total_business_payment = $3,
        total_work_payment = $4,
        total_payment = $5,
        total_expenses = $6,
        petrol_expense = $7,
        other_expense = $8,
        total_borrow = $9,
        total_loans = $10,
        total_savings = $11,
        remaining_payment = $12,
        stocks = $13,
        mutual_funds = $14,
        fixed_deposit = $15,
        real_estate = $16,
        crypto = $17,
        monday = $18,
        tuesday = $19,
        wednesday = $20,
        thursday = $21,
        friday = $22,
        saturday = $23,
        sunday = $24,
        month_year = $25,
        monthly_expenses = $26,
        transactions_data = $27,
        loans_data = $28,
        products_data = $29,
        top_performers = $30,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $31
      RETURNING *`,
      [
        total_business, total_works, total_business_payment, total_work_payment,
        total_payment, total_expenses, petrol_expense, other_expense,
        total_borrow, total_loans, total_savings, remaining_payment,
        stocks, mutual_funds, fixed_deposit, real_estate, crypto,
        monday, tuesday, wednesday, thursday, friday, saturday, sunday,
        month_year, monthly_expenses, transactions_data, loans_data, products_data, top_performers,
        id
      ]
    );
    
    const overview = result.rows[0];
    
    res.json({
      success: true,
      message: '✅ Overview updated successfully',
      data: overview
    });
    
  } catch (err) {
    console.error('❌ Update overview error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to update overview',
      error: err.message
    });
  }
});

// =============================================
// 3. UPDATE BY USER ID - Update Overview by user_id
// =============================================
router.put('/update-by-user/:user_id', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }
    
    const { user_id } = req.params;
    
    // Check if overview exists for this user
    const existingOverview = await getOverviewByUserId(user_id);
    
    if (!existingOverview) {
      return res.status(404).json({
        success: false,
        message: 'Overview not found for this user'
      });
    }
    
    const oldData = existingOverview;
    const id = oldData.id;
    
    const {
      total_business = oldData.total_business,
      total_works = oldData.total_works,
      total_business_payment = oldData.total_business_payment,
      total_work_payment = oldData.total_work_payment,
      total_payment = oldData.total_payment,
      total_expenses = oldData.total_expenses,
      petrol_expense = oldData.petrol_expense,
      other_expense = oldData.other_expense,
      total_borrow = oldData.total_borrow,
      total_loans = oldData.total_loans,
      total_savings = oldData.total_savings,
      remaining_payment = oldData.remaining_payment,
      stocks = oldData.stocks,
      mutual_funds = oldData.mutual_funds,
      fixed_deposit = oldData.fixed_deposit,
      real_estate = oldData.real_estate,
      crypto = oldData.crypto,
      monday = oldData.monday,
      tuesday = oldData.tuesday,
      wednesday = oldData.wednesday,
      thursday = oldData.thursday,
      friday = oldData.friday,
      saturday = oldData.saturday,
      sunday = oldData.sunday,
      month_year = oldData.month_year,
      monthly_expenses = oldData.monthly_expenses,
      transactions_data = oldData.transactions_data,
      loans_data = oldData.loans_data,
      products_data = oldData.products_data,
      top_performers = oldData.top_performers
    } = req.body;
    
    const result = await db.query(
      `UPDATE Personal_overview SET
        total_business = $1,
        total_works = $2,
        total_business_payment = $3,
        total_work_payment = $4,
        total_payment = $5,
        total_expenses = $6,
        petrol_expense = $7,
        other_expense = $8,
        total_borrow = $9,
        total_loans = $10,
        total_savings = $11,
        remaining_payment = $12,
        stocks = $13,
        mutual_funds = $14,
        fixed_deposit = $15,
        real_estate = $16,
        crypto = $17,
        monday = $18,
        tuesday = $19,
        wednesday = $20,
        thursday = $21,
        friday = $22,
        saturday = $23,
        sunday = $24,
        month_year = $25,
        monthly_expenses = $26,
        transactions_data = $27,
        loans_data = $28,
        products_data = $29,
        top_performers = $30,
        updated_at = CURRENT_TIMESTAMP
      WHERE user_id = $31
      RETURNING *`,
      [
        total_business, total_works, total_business_payment, total_work_payment,
        total_payment, total_expenses, petrol_expense, other_expense,
        total_borrow, total_loans, total_savings, remaining_payment,
        stocks, mutual_funds, fixed_deposit, real_estate, crypto,
        monday, tuesday, wednesday, thursday, friday, saturday, sunday,
        month_year, monthly_expenses, transactions_data, loans_data, products_data, top_performers,
        user_id
      ]
    );
    
    const overview = result.rows[0];
    
    res.json({
      success: true,
      message: '✅ Overview updated successfully by user_id',
      data: overview
    });
    
  } catch (err) {
    console.error('❌ Update overview by user error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to update overview',
      error: err.message
    });
  }
});

// =============================================
// 4. GET - All Overviews or Single Overview
// =============================================
// GET all overviews
router.get('/all', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }
    
    const result = await db.query(
      `SELECT o.*, u.full_name 
       FROM Personal_overview o
       LEFT JOIN Personal_users u ON o.user_id = u.id
       ORDER BY o.created_at DESC`
    );
    
    res.json({
      success: true,
      count: result.rows.length,
      data: result.rows
    });
    
  } catch (err) {
    console.error('❌ Fetch all overviews error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch overviews',
      error: err.message
    });
  }
});

// GET single overview by ID
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
      `SELECT o.*, u.full_name 
       FROM Personal_overview o
       LEFT JOIN Personal_users u ON o.user_id = u.id
       WHERE o.id = $1`,
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Overview not found'
      });
    }
    
    res.json({
      success: true,
      data: result.rows[0]
    });
    
  } catch (err) {
    console.error('❌ Fetch overview error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch overview',
      error: err.message
    });
  }
});

// GET overview by user_id
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
      `SELECT o.*, u.full_name 
       FROM Personal_overview o
       LEFT JOIN Personal_users u ON o.user_id = u.id
       WHERE o.user_id = $1`,
      [user_id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Overview not found for this user'
      });
    }
    
    res.json({
      success: true,
      data: result.rows[0]
    });
    
  } catch (err) {
    console.error('❌ Fetch overview by user error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch overview',
      error: err.message
    });
  }
});

// =============================================
// 5. DELETE - Delete Overview by ID
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
    
    // Check if overview exists
    const existingOverview = await db.query(
      'SELECT * FROM Personal_overview WHERE id = $1',
      [id]
    );
    
    if (existingOverview.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Overview not found'
      });
    }
    
    await db.query('DELETE FROM Personal_overview WHERE id = $1', [id]);
    
    res.json({
      success: true,
      message: '✅ Overview deleted successfully',
      deletedId: parseInt(id)
    });
    
  } catch (err) {
    console.error('❌ Delete overview error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to delete overview',
      error: err.message
    });
  }
});

// DELETE overview by user_id
router.delete('/delete-by-user/:user_id', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }
    
    const { user_id } = req.params;
    
    // Check if overview exists for this user
    const existingOverview = await getOverviewByUserId(user_id);
    
    if (!existingOverview) {
      return res.status(404).json({
        success: false,
        message: 'Overview not found for this user'
      });
    }
    
    await db.query('DELETE FROM Personal_overview WHERE user_id = $1', [user_id]);
    
    res.json({
      success: true,
      message: '✅ Overview deleted successfully by user_id',
      deletedUserId: parseInt(user_id)
    });
    
  } catch (err) {
    console.error('❌ Delete overview by user error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to delete overview',
      error: err.message
    });
  }
});

// =============================================
// 6. UPSERT - Create or Update Overview
// =============================================
router.post('/upsert', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }
    
    const { user_id } = req.body;
    
    if (!user_id) {
      return res.status(400).json({
        success: false,
        message: 'user_id is required'
      });
    }
    
    // Check if overview exists
    const existingOverview = await getOverviewByUserId(user_id);
    
    if (existingOverview) {
      // Update existing
      const { id } = existingOverview;
      
      const {
        total_business = existingOverview.total_business,
        total_works = existingOverview.total_works,
        total_business_payment = existingOverview.total_business_payment,
        total_work_payment = existingOverview.total_work_payment,
        total_payment = existingOverview.total_payment,
        total_expenses = existingOverview.total_expenses,
        petrol_expense = existingOverview.petrol_expense,
        other_expense = existingOverview.other_expense,
        total_borrow = existingOverview.total_borrow,
        total_loans = existingOverview.total_loans,
        total_savings = existingOverview.total_savings,
        remaining_payment = existingOverview.remaining_payment,
        stocks = existingOverview.stocks,
        mutual_funds = existingOverview.mutual_funds,
        fixed_deposit = existingOverview.fixed_deposit,
        real_estate = existingOverview.real_estate,
        crypto = existingOverview.crypto,
        monday = existingOverview.monday,
        tuesday = existingOverview.tuesday,
        wednesday = existingOverview.wednesday,
        thursday = existingOverview.thursday,
        friday = existingOverview.friday,
        saturday = existingOverview.saturday,
        sunday = existingOverview.sunday,
        month_year = existingOverview.month_year,
        monthly_expenses = existingOverview.monthly_expenses,
        transactions_data = existingOverview.transactions_data,
        loans_data = existingOverview.loans_data,
        products_data = existingOverview.products_data,
        top_performers = existingOverview.top_performers
      } = req.body;
      
      const result = await db.query(
        `UPDATE Personal_overview SET
          total_business = $1,
          total_works = $2,
          total_business_payment = $3,
          total_work_payment = $4,
          total_payment = $5,
          total_expenses = $6,
          petrol_expense = $7,
          other_expense = $8,
          total_borrow = $9,
          total_loans = $10,
          total_savings = $11,
          remaining_payment = $12,
          stocks = $13,
          mutual_funds = $14,
          fixed_deposit = $15,
          real_estate = $16,
          crypto = $17,
          monday = $18,
          tuesday = $19,
          wednesday = $20,
          thursday = $21,
          friday = $22,
          saturday = $23,
          sunday = $24,
          month_year = $25,
          monthly_expenses = $26,
          transactions_data = $27,
          loans_data = $28,
          products_data = $29,
          top_performers = $30,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $31
        RETURNING *`,
        [
          total_business, total_works, total_business_payment, total_work_payment,
          total_payment, total_expenses, petrol_expense, other_expense,
          total_borrow, total_loans, total_savings, remaining_payment,
          stocks, mutual_funds, fixed_deposit, real_estate, crypto,
          monday, tuesday, wednesday, thursday, friday, saturday, sunday,
          month_year, monthly_expenses, transactions_data, loans_data, products_data, top_performers,
          id
        ]
      );
      
      const overview = result.rows[0];
      
      return res.json({
        success: true,
        message: '✅ Overview updated successfully (upsert)',
        data: overview
      });
      
    } else {
      // Create new
      const {
        total_business = 0,
        total_works = 0,
        total_business_payment = 0,
        total_work_payment = 0,
        total_payment = 0,
        total_expenses = 0,
        petrol_expense = 0,
        other_expense = 0,
        total_borrow = 0,
        total_loans = 0,
        total_savings = 0,
        remaining_payment = 0,
        stocks = 0,
        mutual_funds = 0,
        fixed_deposit = 0,
        real_estate = 0,
        crypto = 0,
        monday = 0,
        tuesday = 0,
        wednesday = 0,
        thursday = 0,
        friday = 0,
        saturday = 0,
        sunday = 0,
        month_year = 'July 2024',
        monthly_expenses = '{}',
        transactions_data = '[]',
        loans_data = '[]',
        products_data = '[]',
        top_performers = '{}'
      } = req.body;
      
      const result = await db.query(
        `INSERT INTO Personal_overview (
          user_id,
          total_business, total_works, total_business_payment, total_work_payment,
          total_payment, total_expenses, petrol_expense, other_expense,
          total_borrow, total_loans, total_savings, remaining_payment,
          stocks, mutual_funds, fixed_deposit, real_estate, crypto,
          monday, tuesday, wednesday, thursday, friday, saturday, sunday,
          month_year, monthly_expenses, transactions_data, loans_data, products_data, top_performers
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31)
        RETURNING *`,
        [
          user_id,
          total_business, total_works, total_business_payment, total_work_payment,
          total_payment, total_expenses, petrol_expense, other_expense,
          total_borrow, total_loans, total_savings, remaining_payment,
          stocks, mutual_funds, fixed_deposit, real_estate, crypto,
          monday, tuesday, wednesday, thursday, friday, saturday, sunday,
          month_year, monthly_expenses, transactions_data, loans_data, products_data, top_performers
        ]
      );
      
      const overview = result.rows[0];
      
      return res.status(201).json({
        success: true,
        message: '✅ Overview created successfully (upsert)',
        data: overview
      });
    }
    
  } catch (err) {
    console.error('❌ Upsert overview error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to upsert overview',
      error: err.message
    });
  }
});

module.exports = router;