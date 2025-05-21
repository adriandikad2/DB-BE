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

    // Check if user is the host
    if (room.host_id !== userId) {
      return res.status(403).json({ message: "Only the host can start the game" });
    }

    // Check if game is already in progress
    if (room.status !== "waiting") {
      return res.status(400).json({ message: "Game is already in progress" });
    }

    // Check if there are enough players
    const playerCountResult = await pool.query(
      "SELECT COUNT(*) FROM room_players WHERE room_id = $1",
      [roomId]
    );

    const playerCount = Number.parseInt(playerCountResult.rows[0].count);
    if (playerCount < 2) {
      return res.status(400).json({ message: "Need at least 2 players to start" });
    }

    // Get a random prompt for the first round
    const promptResult = await pool.query(
      "SELECT * FROM prompts ORDER BY RANDOM() LIMIT 1"
    );

    if (promptResult.rows.length === 0) {
      return res.status(500).json({ message: "No prompts available" });
    }

    const prompt = promptResult.rows[0];

    // Start the game
    await pool.query(
      `UPDATE rooms SET 
        status = 'playing', 
        current_round = 1, 
        current_phase = 'drawing', 
        current_prompt_id = $1,
        phase_end_time = CURRENT_TIMESTAMP + (drawing_time * INTERVAL '1 second')
      WHERE id = $2`,
      [prompt.id, roomId]
    );

    res.json({ message: "Game started successfully" });
  } catch (error) {
    console.error("Start game error:", error);
    res.status(500).json({ message: "Server error" });
  }
}
