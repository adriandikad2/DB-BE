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

    // Check if user is already in the room
    const existingPlayerResult = await pool.query(
      "SELECT * FROM room_players WHERE room_id = $1 AND user_id = $2",
      [roomId, userId]
    );

    if (existingPlayerResult.rows.length > 0) {
      // Allow rejoin regardless of room status
      return res.json({ message: "Already in room" });
    }

    // If not already in the room, only allow join if room is in waiting status
    if (room.status !== "waiting") {
      return res.status(400).json({ message: "Game is already in progress" });
    }

    // Check if room is full
    const playerCountResult = await pool.query(
      "SELECT COUNT(*) FROM room_players WHERE room_id = $1",
      [roomId]
    );
    const playerCount = Number.parseInt(playerCountResult.rows[0].count);

    if (playerCount >= room.max_players) {
      return res.status(400).json({ message: "Room is full" });
    }

    // Check if user is in any other rooms and remove them first
    const otherRoomsResult = await pool.query(
      "SELECT room_id FROM room_players WHERE user_id = $1 AND room_id != $2",
      [userId, roomId]
    );

    if (otherRoomsResult.rows.length > 0) {
      // Remove user from all other rooms
      for (const row of otherRoomsResult.rows) {
        const otherRoomId = row.room_id;
        // For each room, check if the user is the host
        const hostCheckResult = await pool.query(
          "SELECT host_id FROM rooms WHERE id = $1",
          [otherRoomId]
        );
        
        if (hostCheckResult.rows.length > 0 && hostCheckResult.rows[0].host_id === userId) {
          // Find new host
          const newHostResult = await pool.query(
            `SELECT user_id FROM room_players 
             WHERE room_id = $1 AND user_id != $2
             ORDER BY joined_at ASC 
             LIMIT 1`,
            [otherRoomId, userId]
          );
          
          if (newHostResult.rows.length > 0) {
            // Assign new host
            await pool.query(
              "UPDATE rooms SET host_id = $1 WHERE id = $2",
              [newHostResult.rows[0].user_id, otherRoomId]
            );
          } else {
            // No other players, delete the room
            await pool.query("DELETE FROM rooms WHERE id = $1", [otherRoomId]);
          }
        }
      }
      
      // Remove user from all other rooms
      await pool.query(
        "DELETE FROM room_players WHERE user_id = $1 AND room_id != $2",
        [userId, roomId]
      );
    }

    // Add user to room (handle race condition for duplicate joins)
    try {
      await pool.query(
        "INSERT INTO room_players (room_id, user_id) VALUES ($1, $2)",
        [roomId, userId]
      );
      res.json({ message: "Joined room successfully" });
    } catch (err) {
      if (err.code === '23505') { // duplicate key
        res.json({ message: "Already in room" });
      } else {
        throw err;
      }
    }
  } catch (error) {
    console.error("Join room error:", error);
    res.status(500).json({ message: "Server error" });
  }
}
