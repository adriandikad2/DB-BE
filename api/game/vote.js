const { authenticateToken } = require("../_middleware/auth");
const { pool } = require("../_config/db");

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    const authResult = await authenticateToken(req);
    
    if (authResult.status) {
      return res.status(authResult.status).json({ message: authResult.message });
    }

    const userId = authResult.user.id;
    const { drawingId, rating } = req.body;

    // Validate input
    if (!drawingId || !rating || rating < 1 || rating > 5) {
      return res.status(400).json({ message: "Valid drawing ID and rating (1-5) are required" });
    }

    // Get drawing details and room info
    const drawingResult = await pool.query(
      `SELECT d.*, r.current_phase, r.current_round
       FROM drawings d
       JOIN rooms r ON d.room_id = r.id 
       WHERE d.id = $1`,
      [drawingId]
    );

    if (drawingResult.rows.length === 0) {
      return res.status(404).json({ message: "Drawing not found" });
    }

    const drawing = drawingResult.rows[0];

    // Check if user is in the room and revalidate session if needed
    const playerResult = await pool.query(
      "SELECT * FROM room_players WHERE room_id = $1 AND user_id = $2",
      [drawing.room_id, userId]
    );

    if (playerResult.rows.length === 0) {
      // Try to automatically rejoin if game is in progress
      const wasInRoomResult = await pool.query(
        "SELECT 1 FROM drawings WHERE room_id = $1 AND artist_id = $2 AND round_number = $3",
        [drawing.room_id, userId, drawing.current_round]
      );
      
      if (wasInRoomResult.rows.length > 0) {
        await pool.query(
          "INSERT INTO room_players (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
          [drawing.room_id, userId]
        );
      } else {
        return res.status(403).json({ message: "You are not in this room" });
      }
    }

    // Check if user is voting on their own drawing
    if (drawing.artist_id === userId) {
      return res.status(400).json({ message: "You cannot vote on your own drawing" });
    }

    // Get room details
    const roomResult = await pool.query(
      "SELECT * FROM rooms WHERE id = $1 AND current_phase = $2",
      [drawing.room_id, "voting"]
    );

    if (roomResult.rows.length === 0) {
      return res.status(400).json({ message: "Room not found or not in voting phase" });
    }

    const room = roomResult.rows[0];

    // Check if user has already voted on this drawing
    const existingVoteResult = await pool.query(
      "SELECT * FROM stars WHERE drawing_id = $1 AND voter_id = $2",
      [drawingId, userId]
    );

    if (existingVoteResult.rows.length > 0) {
      return res.status(400).json({ message: "You have already voted on this drawing" });
    }

    // Submit vote
    await pool.query(
      "INSERT INTO stars (drawing_id, voter_id, rating) VALUES ($1, $2, $3)",
      [drawingId, userId, rating]
    );

    // Check if all players have voted on the current drawing
    const playerCountResult = await pool.query(
      "SELECT COUNT(*) FROM room_players WHERE room_id = $1",
      [drawing.room_id]
    );

    const voteCountResult = await pool.query(
      "SELECT COUNT(*) FROM stars WHERE drawing_id = $1",
      [drawingId]
    );

    const playerCount = Number.parseInt(playerCountResult.rows[0].count);
    const voteCount = Number.parseInt(voteCountResult.rows[0].count);

    // If all eligible players have voted (excluding the artist), move to next drawing
    if (voteCount >= playerCount - 1) {
      // Move to next drawing or next phase if all drawings have been voted on
      const drawingsResult = await pool.query(
        "SELECT COUNT(*) FROM drawings WHERE room_id = $1 AND round_number = $2",
        [drawing.room_id, drawing.round_number]
      );

      const drawingCount = Number.parseInt(drawingsResult.rows[0].count);
      const nextDrawingIndex = (room.current_drawing_index || 0) + 1;

      if (nextDrawingIndex >= drawingCount) {
        // All drawings have been voted on, check if this was the last round
        if (room.current_round >= room.rounds) {
          // Calculate and save final standings before moving to results phase
          const finalPlayersResult = await pool.query(
            `SELECT rp.user_id, u.username
             FROM room_players rp
             JOIN users u ON rp.user_id = u.id
             WHERE rp.room_id = $1`,
            [drawing.room_id]
          );

          // Calculate and save final scores for each player
          for (const player of finalPlayersResult.rows) {
            const ratingsResult = await pool.query(
              `SELECT AVG(v.rating) as avg_rating
               FROM drawings d
               JOIN stars v ON d.id = v.drawing_id
               WHERE d.room_id = $1 AND d.artist_id = $2`,
              [drawing.room_id, player.user_id]
            );

            const avgRating = ratingsResult.rows[0].avg_rating || 0;
            const score = Math.round(avgRating * 20); // Convert to 0-100 scale

            // Save to game_results table
            await pool.query(
              `INSERT INTO game_results (room_id, user_id, username, score, rank)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (room_id, user_id) DO UPDATE
               SET score = EXCLUDED.score,
                   rank = EXCLUDED.rank`,
              [drawing.room_id, player.user_id, player.username, score, 0]
            );
          }

          // Move to results phase
          await pool.query(
            "UPDATE rooms SET current_phase = $1, phase_end_time = NULL WHERE id = $2",
            ["results", drawing.room_id]
          );
        } else {
          // Start next round with new prompt
          const promptResult = await pool.query("SELECT * FROM prompts ORDER BY RANDOM() LIMIT 1");

          if (promptResult.rows.length === 0) {
            return res.status(500).json({ message: "No prompts available" });
          }

          const prompt = promptResult.rows[0];

          await pool.query(
            `UPDATE rooms SET 
              current_round = current_round + 1, 
              current_phase = 'drawing', 
              current_drawing_index = 0,
              current_prompt_id = $1,
              phase_end_time = NOW() + (drawing_time * INTERVAL '1 second')
            WHERE id = $2`,
            [prompt.id, drawing.room_id]
          );
        }
      } else {
        // Move to next drawing
        await pool.query(
          `UPDATE rooms SET 
            current_drawing_index = $1,
            phase_end_time = NOW() + (voting_time * INTERVAL '1 second')
          WHERE id = $2`,
          [nextDrawingIndex, drawing.room_id]
        );
      }
    }

    res.json({ message: "Vote submitted successfully" });
  } catch (error) {
    console.error("Submit vote error:", error);
    res.status(500).json({ message: "Server error" });
  }
}
