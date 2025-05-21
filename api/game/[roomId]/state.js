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

    // Check if room exists, get current prompt, and count drawings
    const roomResult = await pool.query(
      `SELECT r.*, p.text as prompt_text,
              (SELECT COUNT(*) FROM drawings WHERE room_id = r.id AND round_number = r.current_round) as total_drawings
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

    // Check and update phase if needed
    if (room.status === 'playing' && room.phase_end_time && new Date(room.phase_end_time) < new Date()) {
      try {
        if (room.current_phase === 'drawing') {
          // Move from drawing to voting phase
          await pool.query(
            `UPDATE rooms SET 
              current_phase = 'voting', 
              current_drawing_index = 0,
              phase_end_time = NOW() + (voting_time * INTERVAL '1 second')
            WHERE id = $1`,
            [room.id]
          );
          room.current_phase = 'voting';
          room.current_drawing_index = 0;
        } 
        else if (room.current_phase === 'voting') {
          const totalDrawings = parseInt(room.total_drawings);
          
          if (totalDrawings === 0) {
            if (room.current_round >= room.rounds) {
              await pool.query(
                `UPDATE rooms SET 
                  current_phase = 'results', 
                  status = 'completed',
                  phase_end_time = NULL
                WHERE id = $1`,
                [room.id]
              );
              room.current_phase = 'results';
              room.status = 'completed';
            } else {
              const promptResult = await pool.query("SELECT * FROM prompts ORDER BY RANDOM() LIMIT 1");
              const promptId = promptResult.rows[0].id;
              
              await pool.query(
                `UPDATE rooms SET 
                  current_phase = 'drawing', 
                  current_round = current_round + 1,
                  current_prompt_id = $1,
                  phase_end_time = NOW() + (drawing_time * INTERVAL '1 second')
                WHERE id = $2`,
                [promptId, room.id]
              );
              room.current_phase = 'drawing';
              room.current_round += 1;
              room.prompt_text = promptResult.rows[0].text;
            }
          } else if (room.current_drawing_index >= totalDrawings - 1) {
            if (room.current_round >= room.rounds) {
              // Calculate and save final standings
              const finalPlayersResult = await pool.query(
                `SELECT rp.user_id, u.username
                 FROM room_players rp
                 JOIN users u ON rp.user_id = u.id
                 WHERE rp.room_id = $1`,
                [room.id]
              );

              for (const player of finalPlayersResult.rows) {
                const ratingsResult = await pool.query(
                  `SELECT AVG(v.rating) as avg_rating
                   FROM drawings d
                   JOIN stars v ON d.id = v.drawing_id
                   WHERE d.room_id = $1 AND d.artist_id = $2`,
                  [room.id, player.user_id]
                );

                const avgRating = ratingsResult.rows[0].avg_rating || 0;
                const score = Math.round(avgRating * 20);

                await pool.query(
                  `INSERT INTO game_results (room_id, user_id, username, score, rank)
                   VALUES ($1, $2, $3, $4, $5)
                   ON CONFLICT (room_id, user_id) DO UPDATE
                   SET score = EXCLUDED.score,
                       rank = EXCLUDED.rank`,
                  [room.id, player.user_id, player.username, score, 0]
                );
              }

              await pool.query(
                `UPDATE rooms SET 
                  current_phase = 'results', 
                  status = 'completed',
                  phase_end_time = NULL
                WHERE id = $1`,
                [room.id]
              );
              room.current_phase = 'results';
              room.status = 'completed';
            } else {
              const promptResult = await pool.query("SELECT * FROM prompts ORDER BY RANDOM() LIMIT 1");
              const promptId = promptResult.rows[0].id;
              
              await pool.query(
                `UPDATE rooms SET 
                  current_phase = 'drawing', 
                  current_round = current_round + 1,
                  current_prompt_id = $1,
                  phase_end_time = NOW() + (drawing_time * INTERVAL '1 second')
                WHERE id = $2`,
                [promptId, room.id]
              );
              room.current_phase = 'drawing';
              room.current_round += 1;
              room.prompt_text = promptResult.rows[0].text;
            }
          } else {
            await pool.query(
              `UPDATE rooms SET 
                current_drawing_index = current_drawing_index + 1,
                phase_end_time = NOW() + (voting_time * INTERVAL '1 second')
              WHERE id = $1`,
              [room.id]
            );
            room.current_drawing_index += 1;
          }
        }
      } catch (error) {
        console.error("Error updating game phase:", error);
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
