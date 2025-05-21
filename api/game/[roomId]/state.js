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

    // Check if room exists and get current prompt
    const roomResult = await pool.query(
      `SELECT r.*, p.text as prompt_text
       FROM rooms r
       LEFT JOIN prompts p ON r.current_prompt_id = p.id
       WHERE r.id = $1`,
      [roomId]
    );

    if (roomResult.rows.length === 0) {
      return res.status(404).json({ message: "Room not found" });
    }

    const room = roomResult.rows[0];

    // Check if user is in the room and revalidate session if needed
    const playerResult = await pool.query(
      "SELECT * FROM room_players WHERE room_id = $1 AND user_id = $2",
      [roomId, userId]
    );

    if (playerResult.rows.length === 0) {
      // Try to automatically rejoin if game is in progress and user was previously in room
      const wasInRoomResult = await pool.query(
        "SELECT 1 FROM drawings WHERE room_id = $1 AND artist_id = $2 AND round_number = $3",
        [roomId, userId, room.current_round]
      );
      
      if (wasInRoomResult.rows.length > 0) {
        // User has drawings in current round, allow rejoin
        await pool.query(
          "INSERT INTO room_players (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
          [roomId, userId]
        );
      } else {
        return res.status(403).json({ message: "You are not in this room" });
      }
    }

    // Calculate time left in current phase
    let timeLeft = 0;
    if (room.phase_end_time) {
      const phaseEndTime = new Date(room.phase_end_time).getTime();
      const currentTime = new Date().getTime();
      timeLeft = Math.max(0, Math.floor((phaseEndTime - currentTime) / 1000));
    }

    // Check if user has submitted a drawing (if in drawing phase)
    let hasSubmitted = false;
    if (room.current_phase === "drawing") {
      const drawingResult = await pool.query(
        "SELECT * FROM drawings WHERE room_id = $1 AND round_number = $2 AND artist_id = $3",
        [roomId, room.current_round, userId]
      );
      hasSubmitted = drawingResult.rows.length > 0;
    }

    res.json({
      roomId: room.id,
      phase: room.current_phase,
      round: room.current_round,
      totalRounds: room.rounds,
      prompt: room.prompt_text,
      timeLeft,
      hasSubmitted,
    });
  } catch (error) {
    console.error("Get game state error:", error);
    res.status(500).json({ message: "Server error" });
  }
}
