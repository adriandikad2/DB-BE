const { pool } = require("./_config/db");
const formidable = require('formidable');
const { Storage } = require('@google-cloud/storage');

const storage = new Storage({
  projectId: process.env.GOOGLE_CLOUD_PROJECT_ID,
  credentials: JSON.parse(process.env.GOOGLE_CLOUD_CREDENTIALS),
});

const bucket = storage.bucket(process.env.GOOGLE_CLOUD_BUCKET);

async function handleGameState(req, res, userId, roomId) {
  try {
    // Check if room exists and get current prompt
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

    // Check and update phase if needed
    if (room.status === 'playing' && room.phase_end_time && new Date(room.phase_end_time) < new Date()) {
      try {
        if (room.current_phase === 'drawing') {
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
    console.error("Game state error:", error);
    res.status(500).json({ message: "Server error" });
  }
}

async function handleSubmitDrawing(req, res, userId, roomId) {
  const form = formidable();

  try {
    const { files } = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, files) => {
        if (err) reject(err);
        resolve({ fields, files });
      });
    });

    // Get current room state
    const roomResult = await pool.query(
      "SELECT * FROM rooms WHERE id = $1",
      [roomId]
    );

    if (roomResult.rows.length === 0) {
      return res.status(404).json({ message: "Room not found" });
    }

    const room = roomResult.rows[0];

    if (room.current_phase !== "drawing") {
      return res.status(400).json({ message: "Room is not in drawing phase" });
    }

    // Check if already submitted
    const existingDrawing = await pool.query(
      "SELECT * FROM drawings WHERE room_id = $1 AND round_number = $2 AND artist_id = $3",
      [roomId, room.current_round, userId]
    );

    if (existingDrawing.rows.length > 0) {
      return res.status(400).json({ message: "Already submitted a drawing for this round" });
    }

    // Upload to Google Cloud Storage
    const blob = bucket.file(`drawings/${roomId}/${userId}_${Date.now()}.png`);
    const blobStream = blob.createWriteStream();

    await new Promise((resolve, reject) => {
      blobStream.on('finish', resolve);
      blobStream.on('error', reject);
      blobStream.end(files.drawing.buffer);
    });

    // Make the file public
    await blob.makePublic();

    // Save drawing record
    await pool.query(
      `INSERT INTO drawings (room_id, artist_id, round_number, prompt_id, image_url)
       VALUES ($1, $2, $3, $4, $5)`,
      [roomId, userId, room.current_round, room.current_prompt_id, blob.publicUrl()]
    );

    res.json({ message: "Drawing submitted successfully" });
  } catch (error) {
    console.error("Submit drawing error:", error);
    res.status(500).json({ message: "Server error" });
  }
}

async function handleDrawingToVote(req, res, userId, roomId) {
  try {
    // Get current room state
    const roomResult = await pool.query(
      `SELECT r.*, 
              (SELECT COUNT(*) FROM drawings WHERE room_id = r.id AND round_number = r.current_round) as total_drawings
       FROM rooms r
       WHERE r.id = $1`,
      [roomId]
    );

    if (roomResult.rows.length === 0) {
      return res.status(404).json({ message: "Room not found" });
    }

    const room = roomResult.rows[0];

    if (room.current_phase !== "voting") {
      return res.status(400).json({ message: "Room is not in voting phase" });
    }

    // Get current drawing
    const drawingResult = await pool.query(
      `SELECT d.*, p.text as prompt_text, u.username as artist_name,
              EXISTS(SELECT 1 FROM stars WHERE drawing_id = d.id AND user_id = $1) as has_voted,
              d.artist_id = $1 as is_own_drawing
       FROM drawings d
       JOIN prompts p ON d.prompt_id = p.id
       JOIN users u ON d.artist_id = u.id
       WHERE d.room_id = $2
       AND d.round_number = $3
       OFFSET $4 LIMIT 1`,
      [userId, roomId, room.current_round, room.current_drawing_index]
    );

    if (drawingResult.rows.length === 0) {
      return res.status(204).end(); // No more drawings to vote on
    }

    const drawing = drawingResult.rows[0];

    res.json({
      phase: room.current_phase,
      timeLeft: Math.max(0, Math.floor((new Date(room.phase_end_time) - new Date()) / 1000)),
      currentDrawingIndex: room.current_drawing_index,
      totalDrawings: parseInt(room.total_drawings),
      drawing: {
        id: drawing.id,
        prompt: drawing.prompt_text,
        imageUrl: drawing.image_url,
        artistName: drawing.artist_name,
        isOwnDrawing: drawing.is_own_drawing,
      },
      hasVoted: drawing.has_voted
    });
  } catch (error) {
    console.error("Get drawing to vote error:", error);
    res.status(500).json({ message: "Server error" });
  }
}

async function handleVote(req, res, userId) {
  const { drawingId, rating } = req.body;

  try {
    if (!drawingId || !rating || rating < 1 || rating > 5) {
      return res.status(400).json({ message: "Invalid vote data" });
    }

    // Check if drawing exists and user hasn't already voted
    const drawingResult = await pool.query(
      `SELECT d.*, r.current_phase
       FROM drawings d
       JOIN rooms r ON d.room_id = r.id
       WHERE d.id = $1 AND d.artist_id != $2`,
      [drawingId, userId]
    );

    if (drawingResult.rows.length === 0) {
      return res.status(404).json({ message: "Drawing not found" });
    }

    const drawing = drawingResult.rows[0];

    if (drawing.current_phase !== "voting") {
      return res.status(400).json({ message: "Voting phase has ended" });
    }

    // Check if already voted
    const existingVote = await pool.query(
      "SELECT * FROM stars WHERE drawing_id = $1 AND user_id = $2",
      [drawingId, userId]
    );

    if (existingVote.rows.length > 0) {
      return res.status(400).json({ message: "Already voted for this drawing" });
    }

    // Record vote
    await pool.query(
      "INSERT INTO stars (drawing_id, user_id, rating) VALUES ($1, $2, $3)",
      [drawingId, userId, rating]
    );

    res.json({ message: "Vote recorded successfully" });
  } catch (error) {
    console.error("Vote error:", error);
    res.status(500).json({ message: "Server error" });
  }
}

async function handleLeaderboard(req, res, roomId) {
  try {
    const resultsQuery = `
      SELECT gr.*, u.username
      FROM game_results gr
      JOIN users u ON gr.user_id = u.id
      WHERE gr.room_id = $1
      ORDER BY gr.score DESC`;

    const results = await pool.query(resultsQuery, [roomId]);

    // Calculate ranks
    const leaderboard = results.rows.map((result, index) => ({
      ...result,
      rank: index + 1
    }));

    res.json(leaderboard);
  } catch (error) {
    console.error("Leaderboard error:", error);
    res.status(500).json({ message: "Server error" });
  }
}

module.exports = {
  handleGameState,
  handleSubmitDrawing,
  handleDrawingToVote,
  handleVote,
  handleLeaderboard,
};
