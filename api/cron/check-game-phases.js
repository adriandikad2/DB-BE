const { pool } = require("../_config/db");

// Only allow cron job to execute this endpoint
export const config = {
  api: {
    externalResolver: true,
  },
};

export default async function handler(req, res) {
  try {
    // Ensure request is from Vercel cron
    if (req.headers['x-vercel-cron'] !== 'true') {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // Find rooms where phase has ended
    const expiredPhasesResult = await pool.query(
      `SELECT r.*, 
              (SELECT COUNT(*) FROM drawings WHERE room_id = r.id AND round_number = r.current_round) as total_drawings
       FROM rooms r
       WHERE r.status = 'playing' 
       AND r.phase_end_time < NOW()
       AND r.phase_end_time IS NOT NULL`
    );

    let processedRooms = 0;
    for (const room of expiredPhasesResult.rows) {
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
          processedRooms++;
        } 
        else if (room.current_phase === 'voting') {
          // Get latest value for total drawings
          const drawingsResult = await pool.query(
            "SELECT COUNT(*) FROM drawings WHERE room_id = $1 AND round_number = $2",
            [room.id, room.current_round]
          );
          
          const totalDrawings = parseInt(drawingsResult.rows[0].count);
          
          // Check for zero drawings edge case
          if (totalDrawings === 0) {
            if (room.current_round >= room.rounds) {
              // Last round, end game
              await pool.query(
                `UPDATE rooms SET 
                  current_phase = 'results', 
                  status = 'completed',
                  phase_end_time = NULL
                WHERE id = $1`,
                [room.id]
              );
            } else {
              // Move to next round
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
            }
            processedRooms++;
            continue;
          }

          // If we've voted on all drawings
          if (room.current_drawing_index >= totalDrawings - 1) {
            if (room.current_round >= room.rounds) {
              // Calculate and save final standings
              const finalPlayersResult = await pool.query(
                `SELECT rp.user_id, u.username
                 FROM room_players rp
                 JOIN users u ON rp.user_id = u.id
                 WHERE rp.room_id = $1`,
                [room.id]
              );

              // Calculate and save scores for each player
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

              // Move to results phase
              await pool.query(
                `UPDATE rooms SET 
                  current_phase = 'results', 
                  status = 'completed',
                  phase_end_time = NULL
                WHERE id = $1`,
                [room.id]
              );
            } else {
              // Start next round
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
            }
          } else {
            // Move to next drawing
            await pool.query(
              `UPDATE rooms SET 
                current_drawing_index = current_drawing_index + 1,
                phase_end_time = NOW() + (voting_time * INTERVAL '1 second')
              WHERE id = $1`,
              [room.id]
            );
          }
          processedRooms++;
        }
      } catch (phaseError) {
        console.error(`Error processing phase transition for room ${room.id}:`, phaseError);
        
        // Try to recover the room
        try {
          const roomCheck = await pool.query("SELECT * FROM rooms WHERE id = $1", [room.id]);
          
          if (roomCheck.rows.length > 0) {
            const checkRoom = roomCheck.rows[0];
            
            // If the room didn't change state after our error, try to fix it
            if (checkRoom.current_phase === room.current_phase) {
              // Set a new phase end time 30 seconds in the future to give time to recover
              await pool.query(
                `UPDATE rooms SET 
                  phase_end_time = NOW() + INTERVAL '30 seconds'
                WHERE id = $1`,
                [room.id]
              );
            }
          }
        } catch (recoveryError) {
          console.error(`Failed to recover room ${room.id}:`, recoveryError);
        }
      }
    }

    res.json({ 
      success: true, 
      message: `Processed ${processedRooms} rooms`
    });
  } catch (error) {
    console.error("Error checking game phases:", error);
    res.status(500).json({ message: "Server error" });
  }
}
