const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

// An idle client can emit an error after the initial connection succeeds.
// Without this listener, Node treats it as an unhandled `error` event and
// terminates the process.
pool.on('error', (err) => {
  console.error('❌ Unexpected PostgreSQL pool error:', err.message);
});

// Verify connectivity without checking out and retaining a client.
pool.query('SELECT 1')
  .then(() => console.log('✅ Connected to Supabase PostgreSQL'))
  .catch((err) => console.error('❌ Database connection failed:', err.message));

module.exports = pool;
