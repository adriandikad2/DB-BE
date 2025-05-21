const { Pool } = require('pg');

let pool;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? {
        rejectUnauthorized: false
      } : false
    });
  }
  return pool;
}

module.exports = {
  pool: {
    query: (...args) => getPool().query(...args),
    end: () => {
      if (pool) {
        return pool.end();
      }
      return Promise.resolve();
    }
  }
};
