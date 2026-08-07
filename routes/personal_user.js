// routes/personal_user.js - CommonJS
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// Import database and supabase with proper error handling
let db, supabase;
try {
  db = require('../db.js');
  console.log('✅ Database module loaded');
} catch (err) {
  console.error('❌ Failed to load db.js:', err.message);
  db = null;
}

try {
  supabase = require('./supabase.js');
  console.log('✅ Supabase module loaded');
} catch (err) {
  console.error('❌ Failed to load supabase.js:', err.message);
  supabase = null;
}

// =============================================
// IMPORT MAILER
// =============================================
const { sendOTP } = require('../utils/mailer');

const router = express.Router();

// =============================================
// MULTER CONFIGURATION - Temp Local Storage
// =============================================
const uploadDir = path.join(__dirname, 'uploads', 'temp');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, `temp_${uniqueSuffix}${ext}`);
  }
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only image files are allowed (JPEG, PNG, GIF, WebP)'), false);
  }
};

const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// =============================================
// SUPABASE BUCKET NAME
// =============================================
const BUCKET_NAME = 'profile-images';

// =============================================
// HELPER: Upload image to Supabase Storage
// =============================================
const uploadToSupabase = async (filePath, fileName) => {
  if (!supabase) {
    console.error('❌ Supabase not initialized');
    return null;
  }
  
  try {
    const fileBuffer = fs.readFileSync(filePath);
    
    const uniqueFileName = `profiles/${Date.now()}-${fileName}`;
    
    const { data, error } = await supabase.storage
      .from(BUCKET_NAME)
      .upload(uniqueFileName, fileBuffer, {
        contentType: 'image/jpeg',
        upsert: true
      });

    if (error) {
      console.error('❌ Supabase upload error:', error.message);
      return null;
    }

    const { data: publicUrlData } = supabase.storage
      .from(BUCKET_NAME)
      .getPublicUrl(uniqueFileName);

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    return publicUrlData.publicUrl;

  } catch (err) {
    console.error('❌ Upload error:', err.message);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    return null;
  }
};

// =============================================
// HELPER: Delete image from Supabase Storage
// =============================================
const deleteFromSupabase = async (imageUrl) => {
  if (!imageUrl || !supabase) return;
  
  try {
    const urlParts = imageUrl.split('/');
    const bucketIndex = urlParts.indexOf(BUCKET_NAME);
    
    if (bucketIndex !== -1) {
      const filePath = urlParts.slice(bucketIndex + 1).join('/');
      
      const { error } = await supabase.storage
        .from(BUCKET_NAME)
        .remove([filePath]);

      if (error) {
        console.error('❌ Supabase delete error:', error.message);
      } else {
        console.log('🗑️ Image deleted from Supabase:', filePath);
      }
    }
  } catch (err) {
    console.error('❌ Delete error:', err.message);
  }
};

// =============================================
// HELPER: Get public URL from Supabase path
// =============================================
const getPublicUrl = (filePath) => {
  if (!filePath || !supabase) return null;
  
  if (filePath.startsWith('http')) return filePath;
  
  const { data } = supabase.storage
    .from(BUCKET_NAME)
    .getPublicUrl(filePath);
    
  return data.publicUrl;
};

// =============================================
// HELPER FUNCTIONS
// =============================================
const hashPassword = async (password) => {
  return await bcrypt.hash(password, 10);
};

const comparePassword = async (password, hash) => {
  return await bcrypt.compare(password, hash);
};

const generateJWT = (user) => {
  return jwt.sign(
    { id: user.id, email: user.email_address || user.email1 },
    process.env.JWT_SECRET || 'your-secret-key',
    { expiresIn: '7d' }
  );
};

const generateOTP = () => {
  return String(Math.floor(100000 + Math.random() * 900000));
};

// =============================================
// CREATE TABLE
// =============================================
const createTable = async () => {
  if (!db) {
    console.error('❌ Database not available');
    return;
  }
  
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS Personal_users (
        id SERIAL PRIMARY KEY,
        full_name VARCHAR(150) NOT NULL,
        profession VARCHAR(150),
        instagram VARCHAR(100),
        phone1 VARCHAR(20),
        phone2 VARCHAR(20),
        email1 VARCHAR(150),
        email2 VARCHAR(150),
        username VARCHAR(150) UNIQUE,
        email_address VARCHAR(150) UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        email_verified BOOLEAN DEFAULT FALSE,
        street TEXT,
        city VARCHAR(100),
        taluka VARCHAR(100),
        district VARCHAR(100),
        state VARCHAR(100),
        pincode VARCHAR(20),
        profile_image TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Personal_users table ready');

    // Create OTP table
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

createTable();

// =============================================
// 1. REGISTER - Create New User
// =============================================
router.post('/register', upload.single('profile_image'), async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    const {
      full_name, profession, instagram, phone1, phone2,
      email1, email2, username, email_address, password,
      street, city, taluka, district, state, pincode
    } = req.body;

    // Validation
    if (!full_name) {
      return res.status(400).json({
        success: false,
        message: 'Full name is required'
      });
    }

    if (!email_address && !email1) {
      return res.status(400).json({
        success: false,
        message: 'Email address is required'
      });
    }

    if (!password) {
      return res.status(400).json({
        success: false,
        message: 'Password is required'
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 6 characters'
      });
    }

    const userEmail = email_address || email1;
    const userUsername = username || userEmail.split('@')[0];

    // Check if user already exists
    const existingUser = await db.query(
      'SELECT id FROM Personal_users WHERE email_address = $1 OR username = $2 OR email1 = $3',
      [userEmail.toLowerCase(), userUsername.toLowerCase(), userEmail.toLowerCase()]
    );

    if (existingUser.rows.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'User already exists with this email or username'
      });
    }

    // Hash password
    const passwordHash = await hashPassword(password);

    // Upload profile image if provided
    let profileImageUrl = null;
    if (req.file) {
      profileImageUrl = await uploadToSupabase(req.file.path, req.file.originalname);
    }

    // Create user
    const result = await db.query(
      `INSERT INTO Personal_users (
        full_name, profession, instagram, phone1, phone2,
        email1, email2, username, email_address, password_hash,
        street, city, taluka, district, state, pincode, profile_image
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      RETURNING id, full_name, profession, instagram, phone1, phone2,
                email1, email2, username, email_address, email_verified,
                street, city, taluka, district, state, pincode, profile_image,
                created_at, updated_at`,
      [
        full_name, profession || null, instagram || null,
        phone1 || null, phone2 || null,
        email1 || null, email2 || null,
        userUsername.toLowerCase(), userEmail.toLowerCase(), passwordHash,
        street || null, city || null, taluka || null,
        district || null, state || null, pincode || null,
        profileImageUrl
      ]
    );

    const user = result.rows[0];

    // Generate JWT
    const token = generateJWT(user);

    res.status(201).json({
      success: true,
      message: '✅ User registered successfully',
      data: {
        ...user,
        profile_image_url: user.profile_image ? getPublicUrl(user.profile_image) : null
      },
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
// 2. LOGIN
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

    // Find user by email or username
    const result = await db.query(
      `SELECT * FROM Personal_users 
       WHERE email_address = $1 OR username = $1 OR email1 = $1`,
      [email.toLowerCase()]
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
      message: '✅ Login successful',
      data: {
        ...user,
        profile_image_url: user.profile_image ? getPublicUrl(user.profile_image) : null
      },
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
// 3. SEND OTP - For Registration
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
      'SELECT id FROM Personal_users WHERE email_address = $1 OR email1 = $1',
      [email_address.toLowerCase()]
    );

    if (existingUser.rows.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Email already registered. Please login.'
      });
    }

    // Generate OTP
    const otp = generateOTP();
    const verifyToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Delete old OTPs
    await db.query(
      'DELETE FROM Personal_otp WHERE email_address = $1',
      [email_address.toLowerCase()]
    );

    // Save new OTP
    await db.query(
      `INSERT INTO Personal_otp (email_address, otp_code, verify_token, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [email_address.toLowerCase(), otp, verifyToken, expiresAt]
    );

    // ✅ Send OTP email
    try {
      await sendOTP(email_address, otp);
      console.log(`📧 OTP sent to: ${email_address}`);
    } catch (emailErr) {
      console.error('❌ Failed to send OTP email:', emailErr.message);
      // Still return success but log error
    }

    res.json({
      success: true,
      message: 'OTP sent successfully to your email',
      verify_token: verifyToken
      // ⚠️ OTP removed from response for security
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
// 4. VERIFY OTP
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
      [email_address.toLowerCase(), otp]
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
      'SELECT id FROM Personal_users WHERE email_address = $1 OR email1 = $1',
      [email_address.toLowerCase()]
    );

    if (user.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Email not found'
      });
    }

    // Generate OTP
    const otp = generateOTP();
    const verifyToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    // Delete old OTPs
    await db.query(
      'DELETE FROM Personal_otp WHERE email_address = $1',
      [email_address.toLowerCase()]
    );

    // Save new OTP
    await db.query(
      `INSERT INTO Personal_otp (email_address, otp_code, verify_token, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [email_address.toLowerCase(), otp, verifyToken, expiresAt]
    );

    // ✅ Send OTP email
    try {
      await sendOTP(email_address, otp);
      console.log(`📧 Reset OTP sent to: ${email_address}`);
    } catch (emailErr) {
      console.error('❌ Failed to send OTP email:', emailErr.message);
    }

    res.json({
      success: true,
      message: 'OTP sent successfully to your email',
      verify_token: verifyToken
      // ⚠️ OTP removed from response for security
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

    const otpRecord = await db.query(
      `SELECT * FROM Personal_otp 
       WHERE email_address = $1 AND otp_code = $2 AND verified = FALSE
       ORDER BY created_at DESC LIMIT 1`,
      [email_address.toLowerCase(), otp]
    );

    if (otpRecord.rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid OTP'
      });
    }

    const record = otpRecord.rows[0];

    if (new Date(record.expires_at) < new Date()) {
      await db.query('DELETE FROM Personal_otp WHERE id = $1', [record.id]);
      return res.status(400).json({
        success: false,
        message: 'OTP has expired. Please request a new one.'
      });
    }

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
      [email_address.toLowerCase(), verify_token]
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
      'UPDATE Personal_users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE email_address = $2 OR email1 = $2',
      [passwordHash, email_address.toLowerCase()]
    );

    // Clean up OTP records
    await db.query(
      'DELETE FROM Personal_otp WHERE email_address = $1',
      [email_address.toLowerCase()]
    );

    res.json({
      success: true,
      message: '✅ Password reset successfully'
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
// 8. UPDATE USER (Full Update with Image)
// =============================================
router.put('/update/:id', upload.single('profile_image'), async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }
    
    const { id } = req.params;

    const existingUser = await db.query('SELECT * FROM Personal_users WHERE id = $1', [id]);

    if (existingUser.rows.length === 0) {
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const oldUser = existingUser.rows[0];
    const {
      full_name, profession, instagram, phone1, phone2,
      email1, email2, street, city, taluka, district, state, pincode
    } = req.body;

    let profileImageUrl = oldUser.profile_image;
    
    if (req.file) {
      if (oldUser.profile_image) {
        await deleteFromSupabase(oldUser.profile_image);
      }
      profileImageUrl = await uploadToSupabase(req.file.path, req.file.originalname);
    } else if (req.body.profile_image_url) {
      profileImageUrl = req.body.profile_image_url;
    }

    const result = await db.query(
      `UPDATE Personal_users SET
        full_name = $1, profession = $2, instagram = $3,
        phone1 = $4, phone2 = $5, email1 = $6, email2 = $7,
        street = $8, city = $9, taluka = $10,
        district = $11, state = $12, pincode = $13,
        profile_image = $14, updated_at = CURRENT_TIMESTAMP
      WHERE id = $15
      RETURNING id, full_name, profession, instagram, phone1, phone2,
                email1, email2, username, email_address, email_verified,
                street, city, taluka, district, state, pincode, profile_image,
                created_at, updated_at`,
      [
        full_name || oldUser.full_name,
        profession !== undefined ? profession : oldUser.profession,
        instagram !== undefined ? instagram : oldUser.instagram,
        phone1 !== undefined ? phone1 : oldUser.phone1,
        phone2 !== undefined ? phone2 : oldUser.phone2,
        email1 !== undefined ? email1 : oldUser.email1,
        email2 !== undefined ? email2 : oldUser.email2,
        street !== undefined ? street : oldUser.street,
        city !== undefined ? city : oldUser.city,
        taluka !== undefined ? taluka : oldUser.taluka,
        district !== undefined ? district : oldUser.district,
        state !== undefined ? state : oldUser.state,
        pincode !== undefined ? pincode : oldUser.pincode,
        profileImageUrl,
        id
      ]
    );

    const user = result.rows[0];

    res.json({
      success: true,
      message: '✅ User updated successfully',
      data: {
        ...user,
        profile_image_url: user.profile_image ? getPublicUrl(user.profile_image) : null
      }
    });

  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    console.error('❌ Update error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to update user',
      error: err.message
    });
  }
});

// =============================================
// 9. UPDATE ONLY PROFILE IMAGE
// =============================================
router.put('/update-logo/:id', upload.single('profile_image'), async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }
    
    const { id } = req.params;

    const existingUser = await db.query('SELECT * FROM Personal_users WHERE id = $1', [id]);

    if (existingUser.rows.length === 0) {
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const oldUser = existingUser.rows[0];
    let profileImageUrl = oldUser.profile_image;

    if (req.file) {
      if (oldUser.profile_image) {
        await deleteFromSupabase(oldUser.profile_image);
      }
      profileImageUrl = await uploadToSupabase(req.file.path, req.file.originalname);
    }

    const result = await db.query(
      `UPDATE Personal_users SET
        profile_image = $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
      RETURNING id, full_name, profession, instagram, phone1, phone2,
                email1, email2, username, email_address, email_verified,
                street, city, taluka, district, state, pincode, profile_image,
                created_at, updated_at`,
      [profileImageUrl, id]
    );

    const user = result.rows[0];

    res.json({
      success: true,
      message: '✅ Profile image updated successfully',
      data: {
        ...user,
        profile_image_url: user.profile_image ? getPublicUrl(user.profile_image) : null
      }
    });

  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    console.error('❌ Update logo error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to update profile image',
      error: err.message
    });
  }
});

// =============================================
// 10. UPDATE PASSWORD
// =============================================
router.put('/update-password/:id', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    const { id } = req.params;
    const { current_password, new_password } = req.body;

    if (!current_password || !new_password) {
      return res.status(400).json({
        success: false,
        message: 'Current password and new password are required'
      });
    }

    if (new_password.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'New password must be at least 6 characters'
      });
    }

    // Get user with password hash
    const userResult = await db.query(
      'SELECT password_hash FROM Personal_users WHERE id = $1',
      [id]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const user = userResult.rows[0];

    // Verify current password
    const isValid = await comparePassword(current_password, user.password_hash);
    if (!isValid) {
      return res.status(401).json({
        success: false,
        message: 'Current password is incorrect'
      });
    }

    // Hash new password
    const passwordHash = await hashPassword(new_password);

    // Update password
    await db.query(
      'UPDATE Personal_users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [passwordHash, id]
    );

    res.json({
      success: true,
      message: '✅ Password updated successfully'
    });

  } catch (err) {
    console.error('❌ Update password error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to update password',
      error: err.message
    });
  }
});

// =============================================
// 11. GET ALL USERS
// =============================================
router.get('/all', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }
    
    const result = await db.query(
      `SELECT id, full_name, profession, instagram, phone1, phone2,
              email1, email2, username, email_address, email_verified,
              street, city, taluka, district, state, pincode, profile_image,
              created_at, updated_at
       FROM Personal_users ORDER BY created_at DESC`
    );

    const users = result.rows.map(user => ({
      ...user,
      profile_image_url: user.profile_image ? getPublicUrl(user.profile_image) : null
    }));

    res.json({
      success: true,
      count: users.length,
      data: users
    });

  } catch (err) {
    console.error('❌ Fetch all error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch users',
      error: err.message
    });
  }
});

// =============================================
// 12. GET SINGLE USER BY ID
// =============================================
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
      `SELECT id, full_name, profession, instagram, phone1, phone2,
              email1, email2, username, email_address, email_verified,
              street, city, taluka, district, state, pincode, profile_image,
              created_at, updated_at
       FROM Personal_users WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const user = result.rows[0];

    res.json({
      success: true,
      data: {
        ...user,
        profile_image_url: user.profile_image ? getPublicUrl(user.profile_image) : null
      }
    });

  } catch (err) {
    console.error('❌ Fetch error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch user',
      error: err.message
    });
  }
});

// =============================================
// 13. GET USER BY EMAIL
// =============================================
router.get('/email/:email', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }
    
    const { email } = req.params;
    const result = await db.query(
      `SELECT id, full_name, profession, instagram, phone1, phone2,
              email1, email2, username, email_address, email_verified,
              street, city, taluka, district, state, pincode, profile_image,
              created_at, updated_at
       FROM Personal_users WHERE email_address = $1 OR email1 = $1`,
      [email.toLowerCase()]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const user = result.rows[0];

    res.json({
      success: true,
      data: {
        ...user,
        profile_image_url: user.profile_image ? getPublicUrl(user.profile_image) : null
      }
    });

  } catch (err) {
    console.error('❌ Fetch by email error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch user',
      error: err.message
    });
  }
});

// =============================================
// 14. DELETE USER
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

    const existingUser = await db.query('SELECT * FROM Personal_users WHERE id = $1', [id]);

    if (existingUser.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    if (existingUser.rows[0].profile_image) {
      await deleteFromSupabase(existingUser.rows[0].profile_image);
    }

    await db.query('DELETE FROM Personal_users WHERE id = $1', [id]);

    res.json({
      success: true,
      message: '✅ User deleted successfully',
      deletedId: parseInt(id)
    });

  } catch (err) {
    console.error('❌ Delete error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to delete user',
      error: err.message
    });
  }
});

module.exports = router;