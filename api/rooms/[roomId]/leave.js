const { authenticateToken } = require("../../_middleware/auth");
const { pool } = require("../../_config/db");

export default async function handler(req, res) {
  const { roomId } = req.query;

  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    const authResult = await authenticateToken(req);
    
    if (authResult.status) {
      return res.status(authResult.status).json({ message: authResult.message });
    }

    const userId = authResult.user.id;

    // Check if room exists
    const roomResult = await pool.query(
      "SELECT * FROM rooms WHERE id = $1",
      [roomId]
    );

    if (roomResult.rows.length === 0) {
      return res.status(404).json({ message: "Room not found" });
    }

    const room = roomResult.rows[0];

    // Remove user from room
    await pool.query(
      "DELETE FROM room_players WHERE room_id = $1 AND user_id = $2",
      [roomId, userId]
    );

    // If user is the host, either assign a new host or delete the room
    if (room.host_id === userId) {
      // Find another player to be the host
      const newHostResult = await pool.query(
        `SELECT user_id FROM room_players 
         WHERE room_id = $1 
         ORDER BY joined_at ASC 
         LIMIT 1`,
        [roomId]
      );

      if (newHostResult.rows.length > 0) {
        // Assign new host
        await pool.query(
          "UPDATE rooms SET host_id = $1 WHERE id = $2",
          [newHostResult.rows[0].user_id, roomId]
        );
      } else {
        // No players left, delete the room (drawings are NOT deleted)
        await pool.query("DELETE FROM rooms WHERE id = $1", [roomId]);
      }
    }

    res.json({ message: "Left room successfully" });
  } catch (error) {
    console.error("Leave room error:", error);
    res.status(500).json({ message: "Server error" });
  }
}
