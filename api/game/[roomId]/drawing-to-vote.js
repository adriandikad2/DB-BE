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

    // Check if room exists and is in voting phase
    const roomResult = await pool.query(
      `SELECT r.*, p.text as prompt_text
       FROM rooms r
       LEFT JOIN prompts p ON r.current_prompt_id = p.id
       WHERE r.id = $1 AND r.current_phase = $2`,
      [roomId, "voting"]
    );

    if (roomResult.rows.length === 0) {
      return res.status(204).send();
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

    // Get all drawings for this round
    const drawingsResult = await pool.query(
      `SELECT d.id, d.artist_id, d.image_url, u.username as artist_name
       FROM drawings d
       JOIN users u ON d.artist_id = u.id
       WHERE d.room_id = $1 AND d.round_number = $2
       ORDER BY d.created_at ASC`,
      [roomId, room.current_round]
    );

    if (drawingsResult.rows.length === 0) {
      return res.status(404).json({ message: "No drawings found for this round" });
    }

    // Get the current drawing to vote on
    const currentDrawingIndex = room.current_drawing_index || 0;
    if (currentDrawingIndex >= drawingsResult.rows.length) {
      // All drawings have been voted on for this round
      return res.status(204).send(); // No Content, signal frontend to move to next phase
    }

    const currentDrawing = drawingsResult.rows[currentDrawingIndex];

    // Check if user has already voted on this drawing
    const voteResult = await pool.query(
      "SELECT * FROM stars WHERE drawing_id = $1 AND voter_id = $2",
      [currentDrawing.id, userId]
    );

    const hasVoted = voteResult.rows.length > 0;

    // Calculate time left in voting phase
    let timeLeft = 0;
    if (room.phase_end_time) {
      const phaseEndTime = new Date(room.phase_end_time).getTime();
      const currentTime = new Date().getTime();
      timeLeft = Math.max(0, Math.floor((phaseEndTime - currentTime) / 1000));
    }

    res.json({
      phase: "voting",
      drawing: {
        id: currentDrawing.id,
        artistId: currentDrawing.artist_id,
        artistName: currentDrawing.artist_name,
        imageUrl: currentDrawing.image_url,
        prompt: room.prompt_text,
        isOwnDrawing: currentDrawing.artist_id === userId,
      },
      currentDrawingIndex,
      totalDrawings: drawingsResult.rows.length,
      timeLeft,
      hasVoted,
    });
  } catch (error) {
    console.error("Get drawing to vote error:", error);
    res.status(500).json({ message: "Server error" });
  }
}
