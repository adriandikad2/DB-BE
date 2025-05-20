const jwt = require("jsonwebtoken")
const { pool } = require("../config/db")

// Middleware to verify JWT token
const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers["authorization"]
    const token = authHeader && authHeader.split(" ")[1]

    if (!token) {
      return res.status(401).json({ message: "Authentication required" })
    }

    jwt.verify(token, process.env.JWT_SECRET, async (err, decoded) => {
      if (err) {
        return res.status(403).json({ message: "Invalid or expired token" })
      }

      // Check if user exists in database
      const userResult = await pool.query("SELECT id, username FROM users WHERE id = $1", [decoded.userId])

      if (userResult.rows.length === 0) {
        return res.status(404).json({ message: "User not found" })
      }

      // Add user info to request object
      req.user = userResult.rows[0]
      next()
    })
  } catch (error) {
    console.error("Auth middleware error:", error)
    res.status(500).json({ message: "Server error" })
  }
}

module.exports = {
  authenticateToken,
}
