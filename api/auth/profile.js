const { authenticateToken } = require("../_middleware/auth");
const { pool } = require("../_config/db");

export default async function handler(req, res) {
  if (req.method !== 'PUT') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    const authResult = await authenticateToken(req);
    
    if (authResult.status) {
      return res.status(authResult.status).json({ message: authResult.message });
    }

    const { username } = req.body;
    const userId = authResult.user.id;

    // Check if new username already exists for different user
    const userCheck = await pool.query(
      "SELECT * FROM users WHERE username = $1 AND id != $2",
      [username, userId]
    );

    if (userCheck.rows.length > 0) {
      return res.status(400).json({ message: "Username already taken" });
    }

    // Update username
    const result = await pool.query(
      "UPDATE users SET username = $1 WHERE id = $2 RETURNING id, username",
      [username, userId]
    );

    res.json({
      message: "Profile updated successfully",
      user: result.rows[0],
    });
  } catch (error) {
    console.error("Update profile error:", error);
    res.status(500).json({ message: "Server error" });
  }
}
