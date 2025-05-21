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

    // Check if room exists
    const roomResult = await pool.query(
      "SELECT * FROM rooms WHERE id = $1",
      [roomId]
    );

    if (roomResult.rows.length === 0) {
      return res.status(404).json({ message: "Room not found" });
    }

    const room = roomResult.rows[0];

    // Get players and their scores
    let players = [];
    if (room.current_phase === 'results') {
      // Get final standings from game_results if in results phase
      const resultsQuery = await pool.query(
        `SELECT user_id as id, username, score
         FROM game_results
         WHERE room_id = $1
         ORDER BY rank ASC`,
        [roomId]
      );
      players = resultsQuery.rows;
    } else {
      // Calculate live standings for in-progress games
      const playersResult = await pool.query(
        `SELECT rp.user_id, u.username
         FROM room_players rp
         JOIN users u ON rp.user_id = u.id
         WHERE rp.room_id = $1`,
        [roomId]
      );

      for (const player of playersResult.rows) {
        const ratingsResult = await pool.query(
          `SELECT AVG(v.rating) as avg_rating
           FROM drawings d
           JOIN stars v ON d.id = v.drawing_id
           WHERE d.room_id = $1 AND d.artist_id = $2`,
          [roomId, player.user_id]
        );

        const avgRating = ratingsResult.rows[0].avg_rating || 0;
        const score = Math.round(avgRating * 20); // Convert to 0-100 scale

        players.push({
          id: player.user_id,
          username: player.username,
          score,
        });
      }

      // Sort players by score (highest first)
      players.sort((a, b) => b.score - a.score);
    }

    // Get all drawings with their ratings
    const drawingsResult = await pool.query(
      `SELECT d.id, d.round_number, d.artist_id, d.image_url, p.text as prompt_text, 
              u.username as artist_name, AVG(v.rating) as avg_rating
       FROM drawings d
       JOIN users u ON d.artist_id = u.id
       JOIN prompts p ON d.prompt_id = p.id
       LEFT JOIN stars v ON d.id = v.drawing_id
       WHERE d.room_id = $1
       GROUP BY d.id, p.text, u.username
       ORDER BY d.round_number, d.created_at`,
      [roomId]
    );

    const drawings = drawingsResult.rows.map((drawing) => ({
      id: drawing.id,
      roundNumber: drawing.round_number,
      artistId: drawing.artist_id,
      artistName: drawing.artist_name,
      imageUrl: drawing.image_url,
      prompt: drawing.prompt_text,
      averageRating: Number.parseFloat(drawing.avg_rating) || 0,
    }));

    res.json({
      room: {
        id: room.id,
        name: room.name,
        rounds: room.rounds,
      },
      players,
      drawings,
    });
  } catch (error) {
    console.error("Get leaderboard error:", error);
    res.status(500).json({ message: "Server error" });
  }
}
