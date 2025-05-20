const express = require("express")
const { pool } = require("../config/db")
const { authenticateToken } = require("../middleware/auth")
const { upload, cloudinary } = require("../config/cloudinary")

const router = express.Router()

// Get all drawings for a user (for profile page)
router.get("/user/:userId/drawings", authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;
    // Only allow users to fetch their own drawings (or add admin check if needed)
    if (parseInt(userId) !== req.user.id) {
      return res.status(403).json({ message: "Forbidden" });
    }
    // Get drawings with average rating
    const drawingsResult = await pool.query(
      `SELECT d.id, d.room_id, d.round_number, d.prompt_id, d.image_url, d.created_at, p.text as prompt_text,
              AVG(s.rating) as average_rating
       FROM drawings d
       LEFT JOIN prompts p ON d.prompt_id = p.id
       LEFT JOIN stars s ON d.id = s.drawing_id
       WHERE d.artist_id = $1
       GROUP BY d.id, p.text
       ORDER BY d.created_at DESC`,
      [userId]
    );
    res.json({ drawings: drawingsResult.rows });
  } catch (error) {
    console.error("Get user drawings error:", error);
    res.status(500).json({ message: "Server error" });
  }
});
// Get current game state
router.get("/:roomId/state", authenticateToken, async (req, res) => {
  try {
    const { roomId } = req.params
    const userId = req.user.id

    // Check if room exists and user is in the room
    const roomResult = await pool.query(
      `SELECT r.*, p.text as prompt_text
       FROM rooms r
       LEFT JOIN prompts p ON r.current_prompt_id = p.id
       WHERE r.id = $1`,
      [roomId],
    )

    if (roomResult.rows.length === 0) {
      return res.status(404).json({ message: "Room not found" })
    }

    const room = roomResult.rows[0]

    // Check if user is in the room and revalidate session if needed
    const playerResult = await pool.query("SELECT * FROM room_players WHERE room_id = $1 AND user_id = $2", [
      roomId,
      userId,
    ])

    if (playerResult.rows.length === 0) {
      // Try to automatically rejoin if game is in progress and user was previously in room
      const wasInRoomResult = await pool.query(
        "SELECT 1 FROM drawings WHERE room_id = $1 AND artist_id = $2 AND round_number = $3",
        [roomId, userId, room.current_round]
      );
      
      if (wasInRoomResult.rows.length > 0) {
        // User has drawings in current round, allow rejoin
        await pool.query("INSERT INTO room_players (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [
          roomId,
          userId,
        ]);
        console.log(`[DEBUG] Automatically rejoined user ${userId} to room ${roomId} during gameplay`);
      } else {
        return res.status(403).json({ message: "You are not in this room" });
      }
    }

    // Calculate time left in current phase
    let timeLeft = 0;
    if (room.phase_end_time) {
      // Log for debugging
      console.log('[DEBUG] phase_end_time from DB:', room.phase_end_time, 'current server time:', new Date());
      const phaseEndTime = new Date(room.phase_end_time).getTime();
      const currentTime = new Date().getTime();
      timeLeft = Math.max(0, Math.floor((phaseEndTime - currentTime) / 1000));
      // Log the computed timeLeft
      console.log('[DEBUG] Computed timeLeft:', timeLeft, 'phase:', room.current_phase, 'drawing_time:', room.drawing_time);
    }

    // Check if user has submitted a drawing (if in drawing phase)
    let hasSubmitted = false
    if (room.current_phase === "drawing") {
      const drawingResult = await pool.query(
        "SELECT * FROM drawings WHERE room_id = $1 AND round_number = $2 AND artist_id = $3",
        [roomId, room.current_round, userId],
      )
      hasSubmitted = drawingResult.rows.length > 0
    }

    res.json({
      roomId: room.id,
      phase: room.current_phase,
      round: room.current_round,
      totalRounds: room.rounds,
      prompt: room.prompt_text,
      timeLeft,
      hasSubmitted,
    })
  } catch (error) {
    console.error("Get game state error:", error)
    res.status(500).json({ message: "Server error" })
  }
})

// Submit a drawing
router.post("/:roomId/submit-drawing", authenticateToken, upload.single("drawing"), async (req, res) => {
  try {
    const { roomId } = req.params
    const userId = req.user.id

    // Check if room exists and is in drawing phase
    const roomResult = await pool.query("SELECT * FROM rooms WHERE id = $1 AND current_phase = $2", [roomId, "drawing"])

    if (roomResult.rows.length === 0) {
      return res.status(400).json({ message: "Room not found or not in drawing phase" })
    }

    const room = roomResult.rows[0]

    // Check if user is in the room and revalidate session if needed
    const playerResult = await pool.query("SELECT * FROM room_players WHERE room_id = $1 AND user_id = $2", [
      roomId,
      userId,
    ])

    if (playerResult.rows.length === 0) {
      // Try to automatically rejoin if game is in progress and user was previously in room this round
      const wasInRoomThisRoundResult = await pool.query(
        "SELECT 1 FROM drawings WHERE room_id = $1 AND artist_id = $2 AND round_number < $3",
        [roomId, userId, room.current_round]
      );
      
      if (wasInRoomThisRoundResult.rows.length > 0) {
        // User has drawings from previous rounds, allow rejoin
        await pool.query("INSERT INTO room_players (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [
          roomId,
          userId,
        ]);
        console.log(`[DEBUG] Automatically rejoined user ${userId} to room ${roomId} during drawing phase`);
      } else {
        return res.status(403).json({ message: "You are not in this room" });
      }
    }

    // Check if user has already submitted a drawing for this round
    const existingDrawingResult = await pool.query(
      "SELECT * FROM drawings WHERE room_id = $1 AND round_number = $2 AND artist_id = $3",
      [roomId, room.current_round, userId],
    )

    if (existingDrawingResult.rows.length > 0) {
      return res.status(400).json({ message: "You have already submitted a drawing for this round" })
    }

    // Get the image URL from Cloudinary (provided by multer-storage-cloudinary)
    if (!req.file || !req.file.path) {
      return res.status(400).json({ message: "No drawing image provided" })
    }

    const imageUrl = req.file.path

    // Save drawing to database
    await pool.query(
      `INSERT INTO drawings (
        room_id, round_number, prompt_id, artist_id, image_url
      ) VALUES ($1, $2, $3, $4, $5)`,
      [roomId, room.current_round, room.current_prompt_id, userId, imageUrl],
    )

    // Check if all players have submitted drawings
    const playerCountResult = await pool.query("SELECT COUNT(*) FROM room_players WHERE room_id = $1", [roomId])

    const drawingCountResult = await pool.query(
      "SELECT COUNT(*) FROM drawings WHERE room_id = $1 AND round_number = $2",
      [roomId, room.current_round],
    )

    const playerCount = Number.parseInt(playerCountResult.rows[0].count)
    const drawingCount = Number.parseInt(drawingCountResult.rows[0].count)

    // If all players have submitted, move to voting phase
    if (drawingCount >= playerCount) {
      await pool.query(
        `UPDATE rooms SET 
          current_phase = 'voting', 
          current_drawing_index = 0,
          phase_end_time = NOW() + (voting_time * INTERVAL '1 second')
        WHERE id = $1`,
        [roomId],
      )
    }

    res.json({ message: "Drawing submitted successfully" })
  } catch (error) {
    console.error("Submit drawing error:", error)
    res.status(500).json({ message: "Server error" })
  }
})

// Get drawing to vote on
router.get("/:roomId/drawing-to-vote", authenticateToken, async (req, res) => {
  try {
    const { roomId } = req.params
    const userId = req.user.id

    // Check if room exists and is in voting phase
    const roomResult = await pool.query(
      `SELECT r.*, p.text as prompt_text
       FROM rooms r
       LEFT JOIN prompts p ON r.current_prompt_id = p.id
       WHERE r.id = $1 AND r.current_phase = $2`,
      [roomId, "voting"],
    )

    if (roomResult.rows.length === 0) {
      return res.status(204).send();
    }

    const room = roomResult.rows[0]

    // Check if user is in the room and revalidate session if needed
    const playerResult = await pool.query("SELECT * FROM room_players WHERE room_id = $1 AND user_id = $2", [
      roomId,
      userId,
    ])

    if (playerResult.rows.length === 0) {
      // Try to automatically rejoin if game is in progress and user was previously in room
      const wasInRoomResult = await pool.query(
        "SELECT 1 FROM drawings WHERE room_id = $1 AND artist_id = $2 AND round_number = $3",
        [roomId, userId, room.current_round]
      );
      
      if (wasInRoomResult.rows.length > 0) {
        // User has drawings in current round, allow rejoin
        await pool.query("INSERT INTO room_players (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [
          roomId,
          userId,
        ]);
        console.log(`[DEBUG] Automatically rejoined user ${userId} to room ${roomId} during voting phase`);
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
      [roomId, room.current_round],
    )

    if (drawingsResult.rows.length === 0) {
      return res.status(404).json({ message: "No drawings found for this round" })
    }

    // Get the current drawing to vote on
    const currentDrawingIndex = room.current_drawing_index || 0
    if (currentDrawingIndex >= drawingsResult.rows.length) {
      // All drawings have been voted on for this round
      return res.status(204).send(); // No Content, signal frontend to move to next phase
    }

    const currentDrawing = drawingsResult.rows[currentDrawingIndex]

    // Check if user has already voted on this drawing
    const voteResult = await pool.query("SELECT * FROM stars WHERE drawing_id = $1 AND voter_id = $2", [
      currentDrawing.id,
      userId,
    ])

    const hasVoted = voteResult.rows.length > 0

    // Calculate time left in voting phase
    let timeLeft = 0
    if (room.phase_end_time) {
      const phaseEndTime = new Date(room.phase_end_time).getTime()
      const currentTime = new Date().getTime()
      timeLeft = Math.max(0, Math.floor((phaseEndTime - currentTime) / 1000))
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
    })
  } catch (error) {
    console.error("Get drawing to vote error:", error)
    res.status(500).json({ message: "Server error" })
  }
})

// Submit a vote
router.post("/vote", authenticateToken, async (req, res) => {
  try {
    const { drawingId, rating } = req.body
    const userId = req.user.id

    // Validate input
    if (!drawingId || !rating || rating < 1 || rating > 5) {
      return res.status(400).json({ message: "Valid drawing ID and rating (1-5) are required" })
    }

    // Get drawing details and room info
    const drawingResult = await pool.query(
      `SELECT d.*, r.current_phase, r.current_round
       FROM drawings d
       JOIN rooms r ON d.room_id = r.id 
       WHERE d.id = $1`, 
      [drawingId]
    )

    if (drawingResult.rows.length === 0) {
      return res.status(404).json({ message: "Drawing not found" })
    }

    const drawing = drawingResult.rows[0]

    // Check if user is in the room and revalidate session if needed
    const playerResult = await pool.query("SELECT * FROM room_players WHERE room_id = $1 AND user_id = $2", [
      drawing.room_id,
      userId,
    ])

    if (playerResult.rows.length === 0) {
      // Try to automatically rejoin if game is in progress and user was previously in room
      const wasInRoomResult = await pool.query(
        "SELECT 1 FROM drawings WHERE room_id = $1 AND artist_id = $2 AND round_number = $3",
        [drawing.room_id, userId, drawing.current_round]
      );
      
      if (wasInRoomResult.rows.length > 0) {
        // User has drawings in current round, allow rejoin
        await pool.query("INSERT INTO room_players (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [
          drawing.room_id,
          userId,
        ]);
        console.log(`[DEBUG] Automatically rejoined user ${userId} to room ${drawing.room_id} during voting phase`);
      } else {
        return res.status(403).json({ message: "You are not in this room" });
      }
    }

    // Check if user is voting on their own drawing
    if (drawing.artist_id === userId) {
      return res.status(400).json({ message: "You cannot vote on your own drawing" })
    }

    // Get room details
    const roomResult = await pool.query("SELECT * FROM rooms WHERE id = $1 AND current_phase = $2", [
      drawing.room_id,
      "voting",
    ])

    if (roomResult.rows.length === 0) {
      return res.status(400).json({ message: "Room not found or not in voting phase" })
    }

    const room = roomResult.rows[0]

    // Check if user has already voted on this drawing
    const existingVoteResult = await pool.query("SELECT * FROM stars WHERE drawing_id = $1 AND voter_id = $2", [
      drawingId,
      userId,
    ])

    if (existingVoteResult.rows.length > 0) {
      return res.status(400).json({ message: "You have already voted on this drawing" })
    }

    // Submit vote
    await pool.query("INSERT INTO stars (drawing_id, voter_id, rating) VALUES ($1, $2, $3)", [
      drawingId,
      userId,
      rating,
    ])

    // Check if all players have voted on the current drawing
    const playerCountResult = await pool.query("SELECT COUNT(*) FROM room_players WHERE room_id = $1", [
      drawing.room_id,
    ])

    const voteCountResult = await pool.query("SELECT COUNT(*) FROM stars WHERE drawing_id = $1", [drawingId])

    const playerCount = Number.parseInt(playerCountResult.rows[0].count)
    const voteCount = Number.parseInt(voteCountResult.rows[0].count)

    // If all eligible players have voted (excluding the artist), move to next drawing
    if (voteCount >= playerCount - 1) {
      // Move to next drawing or next phase if all drawings have been voted on
      const drawingsResult = await pool.query(
        "SELECT COUNT(*) FROM drawings WHERE room_id = $1 AND round_number = $2",
        [drawing.room_id, drawing.round_number],
      )

      const drawingCount = Number.parseInt(drawingsResult.rows[0].count)
      const nextDrawingIndex = (room.current_drawing_index || 0) + 1

      if (nextDrawingIndex >= drawingCount) {
        // All drawings have been voted on, check if this was the last round
        if (room.current_round >= room.rounds) {
          // Game is over, calculate and save final standings before moving to results phase
          const finalPlayersResult = await pool.query(
            `SELECT rp.user_id, u.username
             FROM room_players rp
             JOIN users u ON rp.user_id = u.id
             WHERE rp.room_id = $1`,
            [drawing.room_id]
          );

          // Calculate and save final scores for each player
          for (const [index, player] of finalPlayersResult.rows.entries()) {
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
              [drawing.room_id, player.user_id, player.username, score, index + 1]
            );
          }

          // Move to results phase
          await pool.query("UPDATE rooms SET current_phase = $1, phase_end_time = NULL WHERE id = $2", [
            "results",
            drawing.room_id,
          ]);
        } else {
          // Start next round
          const promptResult = await pool.query("SELECT * FROM prompts ORDER BY RANDOM() LIMIT 1")

          if (promptResult.rows.length === 0) {
            return res.status(500).json({ message: "No prompts available" })
          }

          const prompt = promptResult.rows[0]

          await pool.query(
            `UPDATE rooms SET 
              current_round = current_round + 1, 
              current_phase = 'drawing', 
              current_drawing_index = 0,
              current_prompt_id = $1,
              phase_end_time = NOW() + (drawing_time * INTERVAL '1 second')
            WHERE id = $2`,
            [prompt.id, drawing.room_id],
          )
        }
      } else {
        // Move to next drawing
        await pool.query(
          `UPDATE rooms SET 
            current_drawing_index = $1,
            phase_end_time = NOW() + (voting_time * INTERVAL '1 second')
          WHERE id = $2`,
          [nextDrawingIndex, drawing.room_id],
        )
      }
    }

    res.json({ message: "Vote submitted successfully" })
  } catch (error) {
    console.error("Submit vote error:", error)
    res.status(500).json({ message: "Server error" })
  }
})

// Delete a drawing
router.delete("/drawings/:drawingId", authenticateToken, async (req, res) => {
  try {
    const { drawingId } = req.params;
    const userId = req.user.id;

    // First check if the drawing exists and belongs to the user
    const drawingResult = await pool.query(
      "SELECT * FROM drawings WHERE id = $1",
      [drawingId]
    );

    if (drawingResult.rows.length === 0) {
      return res.status(404).json({ message: "Drawing not found" });
    }

    const drawing = drawingResult.rows[0];

    // Verify the drawing belongs to the user
    if (drawing.artist_id !== userId) {
      return res.status(403).json({ message: "You can only delete your own drawings" });
    }

    // Delete the image from Cloudinary if it's stored there
    if (drawing.image_url && drawing.image_url.includes('cloudinary')) {
      try {
        // Extract the public_id from the Cloudinary URL
        const urlParts = drawing.image_url.split('/');
        const filenameWithExtension = urlParts[urlParts.length - 1];
        const publicId = filenameWithExtension.split('.')[0];
        
        await cloudinary.uploader.destroy(publicId);
        console.log(`Deleted image from Cloudinary: ${publicId}`);
      } catch (cloudinaryError) {
        console.error("Error deleting image from Cloudinary:", cloudinaryError);
        // Continue with deletion from database even if Cloudinary deletion fails
      }
    }

    // Delete the drawing from the database
    // Note: This will also delete associated stars due to ON DELETE CASCADE
    await pool.query("DELETE FROM drawings WHERE id = $1", [drawingId]);

    res.json({ message: "Drawing deleted successfully" });
  } catch (error) {
    console.error("Delete drawing error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// Get leaderboard
router.get("/:roomId/leaderboard", authenticateToken, async (req, res) => {
  try {
    const { roomId } = req.params
    const userId = req.user.id

    // Check if room exists
    const roomResult = await pool.query("SELECT * FROM rooms WHERE id = $1", [roomId])

    if (roomResult.rows.length === 0) {
      return res.status(404).json({ message: "Room not found" })
    }

    const room = roomResult.rows[0]

    // Get final standings from game_results if in results phase, otherwise calculate live standings
    let players = [];
    if (room.current_phase === 'results') {
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
      [roomId],
    )

    const drawings = drawingsResult.rows.map((drawing) => ({
      id: drawing.id,
      roundNumber: drawing.round_number,
      artistId: drawing.artist_id,
      artistName: drawing.artist_name,
      imageUrl: drawing.image_url,
      prompt: drawing.prompt_text,
      averageRating: Number.parseFloat(drawing.avg_rating) || 0,
    }))

    res.json({
      room: {
        id: room.id,
        name: room.name,
        rounds: room.rounds,
      },
      players,
      drawings,
    })
  } catch (error) {
    console.error("Get leaderboard error:", error)
    res.status(500).json({ message: "Server error" })
  }
})

module.exports = router
