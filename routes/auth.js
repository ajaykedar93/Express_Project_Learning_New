// routes/auth.js - CommonJS
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const router = express.Router();

// Import database
let db;
try {
  db = require('../db.js');
  console.log('✅ Database module loaded for Auth');
} catch (err) {
  console.error('❌ Failed to load db.js:', err.message);
  db = null;
}

// Import mailer
const { sendOTP, sendEmail } = require('../utils/mailer');

// =============================================
// CREATE TABLES (if not exists)
// =============================================
const createTables = async () => {
  if (!db) {
    console.error('❌ Database not available');
    return;
  }
  
  try {
    // Users table with authentication fields
    await db.query(`
      CREATE TABLE IF NOT EXISTS Personal_users (
        id SERIAL PRIMARY KEY,
        first_name VARCHAR(100) NOT NULL,
        last_name VARCHAR(100) NOT NULL,
        mobile_number VARCHAR(20) NOT NULL,
        email_address VARCHAR(150) NOT NULL UNIQUE,
        village_city VARCHAR(100),
        state VARCHAR(100),
        district VARCHAR(100),
        taluka VARCHAR(100),
        pincode VARCHAR(20),
        password_hash VARCHAR(255) NOT NULL,
        email_verified BOOLEAN DEFAULT FALSE,
        verify_token VARCHAR(255),
        reset_token VARCHAR(255),
        reset_token_expiry TIMESTAMP,
        profile_image TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Personal_users table ready');

    // OTP table for email verification
    await db.query(`
      CREATE TABLE IF NOT EXISTS Personal_otp (
        id SERIAL PRIMARY KEY,
        email_address VARCHAR(150) NOT NULL,
        otp_code VARCHAR(10) NOT NULL,
        verify_token VARCHAR(255),
        expires_at TIMESTAMP NOT NULL,
        verified BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Personal_otp table ready');

  } catch (err) {
    console.error('❌ Table creation error:', err.message);
  }
};

createTables();

// =============================================
// HELPER FUNCTIONS
// =============================================
const generateOTP = () => {
  return String(Math.floor(100000 + Math.random() * 900000));
};

const generateToken = () => {
  return crypto.randomBytes(32).toString('hex');
};

const hashPassword = async (password) => {
  return await bcrypt.hash(password, 10);
};

const comparePassword = async (password, hash) => {
  return await bcrypt.compare(password, hash);
};

const generateJWT = (user) => {
  return jwt.sign(
    { id: user.id, email: user.email_address },
    process.env.JWT_SECRET || 'your-secret-key',
    { expiresIn: '7d' }
  );
};

// =============================================
// 1. SEND OTP - For Registration
// =============================================
router.post('/send-otp', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    const { email_address } = req.body;

    if (!email_address) {
      return res.status(400).json({
        success: false,
        message: 'Email address is required'
      });
    }

    // Check if email already registered
    const existingUser = await db.query(
      'SELECT id FROM Personal_users WHERE email_address = $1',
      [email_address.trim().toLowerCase()]
    );

    if (existingUser.rows.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Email already registered. Please login.'
      });
    }

    // Generate OTP
    const otp = generateOTP();
    const verifyToken = generateToken();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Delete old OTPs
    await db.query(
      'DELETE FROM Personal_otp WHERE email_address = $1',
      [email_address.trim().toLowerCase()]
    );

    // Save new OTP
    await db.query(
      `INSERT INTO Personal_otp (email_address, otp_code, verify_token, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [email_address.trim().toLowerCase(), otp, verifyToken, expiresAt]
    );

    // Send OTP email
    await sendOTP(email_address, otp);

    res.json({
      success: true,
      message: 'OTP sent successfully',
      verify_token: verifyToken
    });

  } catch (err) {
    console.error('❌ Send OTP error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to send OTP',
      error: err.message
    });
  }
});

// =============================================
// 2. VERIFY OTP - For Registration
// =============================================
router.post('/verify-otp', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    const { email_address, otp } = req.body;

    if (!email_address || !otp) {
      return res.status(400).json({
        success: false,
        message: 'Email and OTP are required'
      });
    }

    // Find OTP record
    const otpRecord = await db.query(
      `SELECT * FROM Personal_otp 
       WHERE email_address = $1 AND otp_code = $2 AND verified = FALSE
       ORDER BY created_at DESC LIMIT 1`,
      [email_address.trim().toLowerCase(), otp]
    );

    if (otpRecord.rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid OTP'
      });
    }

    const record = otpRecord.rows[0];

    // Check if expired
    if (new Date(record.expires_at) < new Date()) {
      await db.query('DELETE FROM Personal_otp WHERE id = $1', [record.id]);
      return res.status(400).json({
        success: false,
        message: 'OTP has expired. Please request a new one.'
      });
    }

    // Mark as verified
    await db.query(
      'UPDATE Personal_otp SET verified = TRUE WHERE id = $1',
      [record.id]
    );

    res.json({
      success: true,
      message: 'OTP verified successfully',
      verify_token: record.verify_token
    });

  } catch (err) {
    console.error('❌ Verify OTP error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to verify OTP',
      error: err.message
    });
  }
});

// =============================================
// 3. REGISTER USER
// =============================================
router.post('/register', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    const {
      first_name,
      last_name,
      mobile_number,
      email_address,
      village_city,
      state,
      district,
      taluka,
      pincode,
      password,
      verify_token
    } = req.body;

    // Validation
    if (!first_name || !last_name || !mobile_number || !email_address || !password) {
      return res.status(400).json({
        success: false,
        message: 'All required fields must be filled'
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 6 characters'
      });
    }

    // Verify OTP token
    const otpRecord = await db.query(
      `SELECT * FROM Personal_otp 
       WHERE email_address = $1 AND verify_token = $2 AND verified = TRUE
       ORDER BY created_at DESC LIMIT 1`,
      [email_address.trim().toLowerCase(), verify_token]
    );

    if (otpRecord.rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Email not verified. Please verify OTP first.'
      });
    }

    // Check if user already exists
    const existingUser = await db.query(
      'SELECT id FROM Personal_users WHERE email_address = $1',
      [email_address.trim().toLowerCase()]
    );

    if (existingUser.rows.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Email already registered'
      });
    }

    // Hash password
    const passwordHash = await hashPassword(password);

    // Create user
    const result = await db.query(
      `INSERT INTO Personal_users (
        first_name, last_name, mobile_number, email_address,
        village_city, state, district, taluka, pincode,
        password_hash, email_verified
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING id, first_name, last_name, email_address, mobile_number, 
                village_city, state, district, taluka, pincode, 
                email_verified, created_at`,
      [
        first_name.trim(),
        last_name.trim(),
        mobile_number.trim(),
        email_address.trim().toLowerCase(),
        village_city || null,
        state || null,
        district || null,
        taluka || null,
        pincode || null,
        passwordHash,
        true // email_verified
      ]
    );

    // Clean up OTP records
    await db.query(
      'DELETE FROM Personal_otp WHERE email_address = $1',
      [email_address.trim().toLowerCase()]
    );

    const user = result.rows[0];

    // Generate JWT
    const token = generateJWT(user);

    res.status(201).json({
      success: true,
      message: 'Registration successful!',
      user: user,
      token: token
    });

  } catch (err) {
    console.error('❌ Register error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to register user',
      error: err.message
    });
  }
});

// =============================================
// 4. LOGIN
// =============================================
router.post('/login', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email and password are required'
      });
    }

    // Find user
    const result = await db.query(
      `SELECT * FROM Personal_users WHERE email_address = $1`,
      [email.trim().toLowerCase()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password'
      });
    }

    const user = result.rows[0];

    // Check password
    const isValid = await comparePassword(password, user.password_hash);
    if (!isValid) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password'
      });
    }

    // Generate JWT
    const token = generateJWT(user);

    // Remove sensitive data
    delete user.password_hash;

    res.json({
      success: true,
      message: 'Login successful',
      user: user,
      token: token
    });

  } catch (err) {
    console.error('❌ Login error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to login',
      error: err.message
    });
  }
});

// =============================================
// 5. FORGOT PASSWORD - Send OTP
// =============================================
router.post('/forgot/send-otp', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    const { email_address } = req.body;

    if (!email_address) {
      return res.status(400).json({
        success: false,
        message: 'Email address is required'
      });
    }

    // Check if user exists
    const user = await db.query(
      'SELECT id FROM Personal_users WHERE email_address = $1',
      [email_address.trim().toLowerCase()]
    );

    if (user.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Email not found'
      });
    }

    // Generate OTP
    const otp = generateOTP();
    const verifyToken = generateToken();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Delete old OTPs
    await db.query(
      'DELETE FROM Personal_otp WHERE email_address = $1',
      [email_address.trim().toLowerCase()]
    );

    // Save new OTP
    await db.query(
      `INSERT INTO Personal_otp (email_address, otp_code, verify_token, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [email_address.trim().toLowerCase(), otp, verifyToken, expiresAt]
    );

    // Send OTP email
    await sendOTP(email_address, otp);

    res.json({
      success: true,
      message: 'OTP sent successfully',
      verify_token: verifyToken
    });

  } catch (err) {
    console.error('❌ Forgot send OTP error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to send OTP',
      error: err.message
    });
  }
});

// =============================================
// 6. FORGOT PASSWORD - Verify OTP
// =============================================
router.post('/forgot/verify-otp', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    const { email_address, otp } = req.body;

    if (!email_address || !otp) {
      return res.status(400).json({
        success: false,
        message: 'Email and OTP are required'
      });
    }

    // Find OTP record
    const otpRecord = await db.query(
      `SELECT * FROM Personal_otp 
       WHERE email_address = $1 AND otp_code = $2 AND verified = FALSE
       ORDER BY created_at DESC LIMIT 1`,
      [email_address.trim().toLowerCase(), otp]
    );

    if (otpRecord.rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid OTP'
      });
    }

    const record = otpRecord.rows[0];

    // Check if expired
    if (new Date(record.expires_at) < new Date()) {
      await db.query('DELETE FROM Personal_otp WHERE id = $1', [record.id]);
      return res.status(400).json({
        success: false,
        message: 'OTP has expired. Please request a new one.'
      });
    }

    // Mark as verified
    await db.query(
      'UPDATE Personal_otp SET verified = TRUE WHERE id = $1',
      [record.id]
    );

    res.json({
      success: true,
      message: 'OTP verified successfully',
      verify_token: record.verify_token
    });

  } catch (err) {
    console.error('❌ Forgot verify OTP error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to verify OTP',
      error: err.message
    });
  }
});

// =============================================
// 7. FORGOT PASSWORD - Reset Password
// =============================================
router.post('/forgot/reset-password', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    const { email_address, new_password, verify_token } = req.body;

    if (!email_address || !new_password || !verify_token) {
      return res.status(400).json({
        success: false,
        message: 'Email, new password, and verify token are required'
      });
    }

    if (new_password.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 6 characters'
      });
    }

    // Verify OTP token
    const otpRecord = await db.query(
      `SELECT * FROM Personal_otp 
       WHERE email_address = $1 AND verify_token = $2 AND verified = TRUE
       ORDER BY created_at DESC LIMIT 1`,
      [email_address.trim().toLowerCase(), verify_token]
    );

    if (otpRecord.rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'OTP not verified. Please verify OTP first.'
      });
    }

    // Hash new password
    const passwordHash = await hashPassword(new_password);

    // Update password
    await db.query(
      'UPDATE Personal_users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE email_address = $2',
      [passwordHash, email_address.trim().toLowerCase()]
    );

    // Clean up OTP records
    await db.query(
      'DELETE FROM Personal_otp WHERE email_address = $1',
      [email_address.trim().toLowerCase()]
    );

    res.json({
      success: true,
      message: 'Password reset successfully'
    });

  } catch (err) {
    console.error('❌ Reset password error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to reset password',
      error: err.message
    });
  }
});

// =============================================
// 8. GET USER PROFILE
// =============================================
router.get('/profile/:id', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    const { id } = req.params;

    const result = await db.query(
      `SELECT id, first_name, last_name, mobile_number, email_address,
              village_city, state, district, taluka, pincode,
              email_verified, profile_image, created_at, updated_at
       FROM Personal_users WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    res.json({
      success: true,
      data: result.rows[0]
    });

  } catch (err) {
    console.error('❌ Profile error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch profile',
      error: err.message
    });
  }
});

module.exports = router;