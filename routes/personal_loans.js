const express = require('express');
const router = express.Router();
const db = require('../db');

// Keep this route self-contained on new deployments.  Existing tables are
// left untouched by `IF NOT EXISTS`.
let loanTablePromise;
const ensureLoanTable = () => {
  if (!loanTablePromise) {
    loanTablePromise = db.query(`
      CREATE TABLE IF NOT EXISTS personal_loans (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES personal_users(id) ON DELETE CASCADE,
        loan_name VARCHAR(150) NOT NULL,
        total_amount NUMERIC(15, 2) NOT NULL,
        emi_amount NUMERIC(15, 2) NOT NULL,
        emi_date DATE NOT NULL,
        total_emi INTEGER NOT NULL,
        remaining_emi INTEGER NOT NULL,
        total_amount_paid NUMERIC(15, 2) NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  return loanTablePromise;
};

router.use(async (req, res, next) => {
  try {
    await ensureLoanTable();
    next();
  } catch (error) {
    console.error('INITIALIZE personal loans:', error);
    res.status(500).json({ success: false, message: 'Loan data is unavailable' });
  }
});

// =====================================================
// GET ALL LOANS
// GET /api/personal-loans/all?user_id=123
// =====================================================

const fetchLoans = async (req, res, userId) => {
  try {
    const hasUserFilter = userId !== undefined && userId !== null && userId !== '';
    const parsedUserId = hasUserFilter ? Number(userId) : null;

    if (hasUserFilter && (!Number.isInteger(parsedUserId) || parsedUserId <= 0)) {
      return res.status(400).json({ success: false, message: 'Invalid user ID' });
    }

    const whereClause = hasUserFilter ? 'WHERE user_id = $1' : '';
    const params = hasUserFilter ? [parsedUserId] : [];

    const result = await db.query(
      `SELECT
        id,
        user_id,
        loan_name,
        total_amount,
        emi_amount,
        emi_date,
        total_emi,
        remaining_emi,
        total_amount_paid,
        GREATEST(total_amount - total_amount_paid, 0) AS total_amount_remaining,
        created_at,
        updated_at
       FROM personal_loans
       ${whereClause}
       ORDER BY emi_date ASC, id DESC`,
      params
    );

    return res.json({
      success: true,
      count: result.rows.length,
      data: result.rows
    });

  } catch (error) {
    console.error('GET personal loans:', error);

    return res.status(500).json({
      success: false,
      message: 'Failed to fetch loans'
    });
  }
};

// Collection endpoints.  These support both query and path user filters so
// existing clients can use /all, /all/:userId, or ?user_id=:userId.
router.get('/', (req, res) => fetchLoans(req, res, req.query.user_id));
router.get('/all/:userId', (req, res) => fetchLoans(req, res, req.params.userId));
router.get('/all', (req, res) => fetchLoans(req, res, req.query.user_id));

// Preferred user-scoped endpoint.
router.get('/user/:userId', (req, res) => fetchLoans(req, res, req.params.userId));

// Backwards-compatible user-scoped endpoint.
router.get('/:userId', (req, res) => fetchLoans(req, res, req.params.userId));

// =====================================================
// ADD LOAN
// POST /api/personal-loans
// =====================================================

router.post('/', async (req, res) => {
  try {
    const {
      user_id,
      loan_name,
      total_amount,
      emi_amount,
      emi_date,
      total_emi,
      remaining_emi,
      total_amount_paid
    } = req.body;

    const userId = Number(user_id);
    const totalAmount = Number(total_amount);
    const emiAmount = Number(emi_amount);
    const totalEmi = Number(total_emi);

    const remainingEmi =
      remaining_emi === '' ||
      remaining_emi === undefined ||
      remaining_emi === null
        ? totalEmi
        : Number(remaining_emi);

    const paid =
      total_amount_paid === '' ||
      total_amount_paid === undefined ||
      total_amount_paid === null
        ? 0
        : Number(total_amount_paid);

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Valid user_id is required'
      });
    }

    if (!loan_name || !loan_name.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Bank / Loan App name is required'
      });
    }

    if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Valid total amount is required'
      });
    }

    if (!Number.isFinite(emiAmount) || emiAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Valid EMI amount is required'
      });
    }

    if (!emi_date) {
      return res.status(400).json({
        success: false,
        message: 'EMI date is required'
      });
    }

    if (!Number.isInteger(totalEmi) || totalEmi <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Valid total EMI is required'
      });
    }

    if (
      !Number.isInteger(remainingEmi) ||
      remainingEmi < 0 ||
      remainingEmi > totalEmi
    ) {
      return res.status(400).json({
        success: false,
        message: 'Remaining EMI is invalid'
      });
    }

    if (
      !Number.isFinite(paid) ||
      paid < 0 ||
      paid > totalAmount
    ) {
      return res.status(400).json({
        success: false,
        message: 'Paid amount is invalid'
      });
    }

    // Check user exists
    const userCheck = await db.query(
      `SELECT id
       FROM personal_users
       WHERE id = $1`,
      [userId]
    );

    if (userCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const result = await db.query(
      `INSERT INTO personal_loans (
        user_id,
        loan_name,
        total_amount,
        emi_amount,
        emi_date,
        total_emi,
        remaining_emi,
        total_amount_paid
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *`,
      [
        userId,
        loan_name.trim(),
        totalAmount,
        emiAmount,
        emi_date,
        totalEmi,
        remainingEmi,
        paid
      ]
    );

    return res.status(201).json({
      success: true,
      message: 'Loan saved successfully',
      data: result.rows[0]
    });

  } catch (error) {
    console.error('ADD personal loan:', error);

    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// =====================================================
// UPDATE LOAN
// PUT /api/personal-loans/:id
// =====================================================

router.put('/:id', async (req, res) => {
  try {
    const loanId = Number(req.params.id);

    const {
      user_id,
      loan_name,
      total_amount,
      emi_amount,
      emi_date,
      total_emi,
      remaining_emi,
      total_amount_paid
    } = req.body;

    const userId = Number(user_id);
    const totalAmount = Number(total_amount);
    const emiAmount = Number(emi_amount);
    const totalEmi = Number(total_emi);
    const remainingEmi = Number(remaining_emi);
    const paid = Number(total_amount_paid);

    if (!Number.isInteger(loanId) || loanId <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid loan ID'
      });
    }

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Valid user_id is required'
      });
    }

    if (!loan_name || !loan_name.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Bank / Loan App name is required'
      });
    }

    if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Valid total amount is required'
      });
    }

    if (!Number.isFinite(emiAmount) || emiAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Valid EMI amount is required'
      });
    }

    if (!emi_date) {
      return res.status(400).json({
        success: false,
        message: 'EMI date is required'
      });
    }

    if (!Number.isInteger(totalEmi) || totalEmi <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Valid total EMI is required'
      });
    }

    if (
      !Number.isInteger(remainingEmi) ||
      remainingEmi < 0 ||
      remainingEmi > totalEmi
    ) {
      return res.status(400).json({
        success: false,
        message: 'Remaining EMI is invalid'
      });
    }

    if (
      !Number.isFinite(paid) ||
      paid < 0 ||
      paid > totalAmount
    ) {
      return res.status(400).json({
        success: false,
        message: 'Paid amount is invalid'
      });
    }

    const result = await db.query(
      `UPDATE personal_loans
       SET
         loan_name = $1,
         total_amount = $2,
         emi_amount = $3,
         emi_date = $4,
         total_emi = $5,
         remaining_emi = $6,
         total_amount_paid = $7
       WHERE id = $8
       AND user_id = $9
       RETURNING *`,
      [
        loan_name.trim(),
        totalAmount,
        emiAmount,
        emi_date,
        totalEmi,
        remainingEmi,
        paid,
        loanId,
        userId
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Loan not found for this user'
      });
    }

    return res.json({
      success: true,
      message: 'Loan updated successfully',
      data: result.rows[0]
    });

  } catch (error) {
    console.error('UPDATE personal loan:', error);

    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// =====================================================
// PAY EMI
// POST /api/personal-loans/pay/:id
// =====================================================

router.post('/pay/:id', async (req, res) => {
  try {
    const loanId = Number(req.params.id);
    const userId = Number(req.body.user_id);

    if (!Number.isInteger(loanId) || loanId <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid loan ID'
      });
    }

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Valid user_id is required'
      });
    }

    const loanResult = await db.query(
      `SELECT *
       FROM personal_loans
       WHERE id = $1
       AND user_id = $2`,
      [loanId, userId]
    );

    if (loanResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Loan not found'
      });
    }

    const loan = loanResult.rows[0];

    const currentRemainingEmi =
      Number(loan.remaining_emi);

    const currentPaid =
      Number(loan.total_amount_paid);

    const emiAmount =
      Number(loan.emi_amount);

    const remainingAmount = Math.max(
      Number(loan.total_amount) - currentPaid,
      0
    );

    if (currentRemainingEmi <= 0) {
      return res.status(400).json({
        success: false,
        message: 'All EMIs are already paid'
      });
    }

    if (emiAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid EMI amount'
      });
    }

    const paymentAmount =
      Math.min(emiAmount, remainingAmount);

    const newPaid =
      currentPaid + paymentAmount;

    const newRemainingEmi =
      currentRemainingEmi - 1;

    const result = await db.query(
      `UPDATE personal_loans
       SET
         total_amount_paid = $1,
         remaining_emi = $2
       WHERE id = $3
       AND user_id = $4
       RETURNING *`,
      [
        newPaid,
        newRemainingEmi,
        loanId,
        userId
      ]
    );

    return res.json({
      success: true,
      message: 'EMI paid successfully',
      data: result.rows[0]
    });

  } catch (error) {
    console.error('PAY EMI:', error);

    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// =====================================================
// DELETE LOAN
// DELETE /api/personal-loans/:id?user_id=123
// =====================================================

router.delete('/:id', async (req, res) => {
  try {
    const loanId = Number(req.params.id);
    const userId = Number(req.query.user_id);

    if (!Number.isInteger(loanId) || loanId <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid loan ID'
      });
    }

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Valid user_id is required'
      });
    }

    const result = await db.query(
      `DELETE FROM personal_loans
       WHERE id = $1
       AND user_id = $2
       RETURNING id`,
      [loanId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Loan not found'
      });
    }

    return res.json({
      success: true,
      message: 'Loan deleted successfully',
      deletedId: result.rows[0].id
    });

  } catch (error) {
    console.error('DELETE personal loan:', error);

    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

module.exports = router;
