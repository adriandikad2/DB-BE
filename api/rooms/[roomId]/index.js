const { authenticateToken } = require("../../_middleware/auth");
const { pool } = require("../../_config/db");

export default async function handler(req, res) {
  const { roomId } = req.query;

  if (req.method !== 'GET') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    const authResult = await authenticateToken(req);
    
    if (authResult.status) {
      return res.status(authResult.status).json({ message: authResult.message });
    }

    const userId = authResult.user.id;

    // Get room details
    const roomResult = await pool.query(
      "SELECT * FROM rooms WHERE id = $1",
      [roomId]
    );

    if (roomResult.rows.length === 0) {
      return res.status(404).json({ message: "Room not found" });
    }

    const room = roomResult.rows[0];

    // Get players in the room
    const playersResult = await pool.query(
      `SELECT u.id, u.username
       FROM room_players rp
       JOIN users u ON rp.user_id = u.id
       WHERE rp.room_id = $1
       ORDER BY rp.joined_at ASC`,
      [roomId]
    );

    // Check if user is in the room
    const isInRoom = playersResult.rows.some((player) => player.id === userId);

    // If room is private and user is not in the room, deny access
    if (room.is_private && !isInRoom) {
      return res.status(403).json({ message: "Access denied to private room" });
    }

    res.json({
      room: {
        id: room.id,
        name: room.name,
        hostId: room.host_id,
        maxPlayers: room.max_players,
        drawingTime: room.drawing_time,
        votingTime: room.voting_time,
        rounds: room.rounds,
        isPrivate: room.is_private,
        status: room.status,
        currentRound: room.current_round,
      },
      players: playersResult.rows,
    });
  } catch (error) {
    console.error("Get room details error:", error);
    res.status(500).json({ message: "Server error" });
  }
}
