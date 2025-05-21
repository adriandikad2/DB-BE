const jwt = require("jsonwebtoken");
const { pool } = require("../_config/db");

async function authenticateToken(req) {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(" ")[1];

    if (!token) {
      return { status: 401, message: "No token provided" };
    }

    const user = jwt.verify(token, process.env.JWT_SECRET);
    
    // Get user details from database
    const result = await pool.query(
      "SELECT id, username FROM users WHERE id = $1",
      [user.userId]
    );

    if (result.rows.length === 0) {
      return { status: 401, message: "User not found" };
    }

    return { user: result.rows[0] };
  } catch (error) {
    console.error("Auth error:", error);
    return { status: 401, message: "Invalid token" };
  }
}

module.exports = { authenticateToken };
