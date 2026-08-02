// personal_user.js - Converted to CommonJS
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

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

    // Get public URL
    const { data: publicUrlData } = supabase.storage
      .from(BUCKET_NAME)
      .getPublicUrl(uniqueFileName);

    // Delete temp file
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
  } catch (err) {
    console.error('❌ Table creation error:', err.message);
  }
};

createTable();

// =============================================
// 1. CREATE (POST) - Add New User
// =============================================
router.post('/add', upload.single('profile_image'), async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }
    
    const {
      full_name, profession, instagram, phone1, phone2,
      email1, email2, street, city, taluka, district, state, pincode
    } = req.body;

    if (!full_name) {
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      return res.status(400).json({
        success: false,
        message: 'full_name is required'
      });
    }

    let profileImageUrl = null;
    if (req.file) {
      profileImageUrl = await uploadToSupabase(req.file.path, req.file.originalname);
    }

    const result = await db.query(
      `INSERT INTO Personal_users (
        full_name, profession, instagram, phone1, phone2,
        email1, email2, street, city, taluka,
        district, state, pincode, profile_image
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING *`,
      [
        full_name, profession || null, instagram || null,
        phone1 || null, phone2 || null, email1 || null, email2 || null,
        street || null, city || null, taluka || null,
        district || null, state || null, pincode || null,
        profileImageUrl
      ]
    );

    const user = result.rows[0];

    res.status(201).json({
      success: true,
      message: '✅ User created successfully',
      data: {
        ...user,
        profile_image_url: user.profile_image
      }
    });

  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    console.error('❌ Create error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to create user',
      error: err.message
    });
  }
});

// =============================================
// 2. UPDATE (PUT) - Update User by ID (Full Update)
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
    
    // If new image is uploaded, replace it
    if (req.file) {
      if (oldUser.profile_image) {
        await deleteFromSupabase(oldUser.profile_image);
      }
      profileImageUrl = await uploadToSupabase(req.file.path, req.file.originalname);
    } else if (req.body.profile_image_url) {
      // If profile_image_url is sent, keep that URL
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
      RETURNING *`,
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
        profile_image_url: user.profile_image
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
// 3. UPDATE ONLY LOGO - Save Adjusted Image
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

    // Only update the profile_image field
    if (req.file) {
      // Delete old image from Supabase
      if (oldUser.profile_image) {
        await deleteFromSupabase(oldUser.profile_image);
      }
      // Upload new image
      profileImageUrl = await uploadToSupabase(req.file.path, req.file.originalname);
    }

    const result = await db.query(
      `UPDATE Personal_users SET
        profile_image = $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
      RETURNING *`,
      [profileImageUrl, id]
    );

    const user = result.rows[0];

    res.json({
      success: true,
      message: '✅ Logo updated successfully',
      data: {
        ...user,
        profile_image_url: user.profile_image
      }
    });

  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    console.error('❌ Update logo error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to update logo',
      error: err.message
    });
  }
});

// =============================================
// 4. GET - All Users or Single User
// =============================================
// GET all users
router.get('/all', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }
    
    const result = await db.query(
      'SELECT * FROM Personal_users ORDER BY created_at DESC'
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

// GET single user by ID
router.get('/:id', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }
    
    const { id } = req.params;
    const result = await db.query('SELECT * FROM Personal_users WHERE id = $1', [id]);

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
// 5. DELETE - Delete User by ID
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
      message: '✅ User and image deleted successfully',
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