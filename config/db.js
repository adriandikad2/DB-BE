const { Pool } = require("pg")
const dotenv = require("dotenv")

dotenv.config()

// Create a PostgreSQL connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false, // Required for Neon.tech
  },
})

// Export the pool for use in other files
module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),
}
