const { pool } = require("./_config/db");
const { authenticateToken } = require("./_middleware/auth");

export default async function handler(req, res) {
  try {
    const authResult = await authenticateToken(req);
    if (authResult.status) {
      return res.status(authResult.status).json({ message: authResult.message });
    }

    const userId = authResult.user.id;
    const action = req.query.action || '';
    const roomId = req.query.roomId;

    switch (true) {
      case req.method === 'GET' && !action && !roomId:
        return handleListRooms(req, res);
      case req.method === 'POST' && !action && !roomId:
        return handleCreateRoom(req, res, userId);
      case action === 'join':
        return handleJoinRoom(req, res, userId, roomId);
      case action === 'leave':
        return handleLeaveRoom(req, res, userId, roomId);
      case action === 'start':
        return handleStartGame(req, res, userId, roomId);
      case !action && roomId:
        return handleGetRoom(req, res, roomId);
      default:
        return res.status(404).json({ message: 'Action not found' });
    }
  } catch (error) {
    console.error("Rooms error:", error);
    return res.status(500).json({ message: "Server error" });
  }
}

async function handleListRooms(req, res) {
  try {
    const roomsResult = await pool.query(
      `SELECT r.*, 
              COUNT(DISTINCT rp.user_id) as player_count,
              ARRAY_AGG(DISTINCT u.username) as players
       FROM rooms r
       LEFT JOIN room_players rp ON r.id = rp.room_id
       LEFT JOIN users u ON rp.user_id = u.id
       WHERE r.status != 'completed'
       GROUP BY r.id
       ORDER BY r.created_at DESC`
    );

    res.json(roomsResult.rows);
  } catch (error) {
    console.error("List rooms error:", error);
    res.status(500).json({ message: "Server error" });
  }
}

async function handleCreateRoom(req, res, userId) {
  const { name, rounds = 3, drawingTime = 80, votingTime = 30 } = req.body;

  try {
    // Start a transaction
    await pool.query('BEGIN');

    // Create room
    const roomResult = await pool.query(
      `INSERT INTO rooms (name, status, rounds, drawing_time, voting_time, host_id)
       VALUES ($1, 'waiting', $2, $3, $4, $5)
       RETURNING *`,
      [name, rounds, drawingTime, votingTime, userId]
    );

    const room = roomResult.rows[0];

    // Add creator as first player
    await pool.query(
      "INSERT INTO room_players (room_id, user_id) VALUES ($1, $2)",
      [room.id, userId]
    );

    await pool.query('COMMIT');

    res.status(201).json(room);
  } catch (error) {
    await pool.query('ROLLBACK');
    console.error("Create room error:", error);
    res.status(500).json({ message: "Server error" });
  }
}

async function handleJoinRoom(req, res, userId, roomId) {
  try {
    // Check if room exists and is joinable
    const roomResult = await pool.query(
      "SELECT * FROM rooms WHERE id = $1",
      [roomId]
    );

    if (roomResult.rows.length === 0) {
      return res.status(404).json({ message: "Room not found" });
    }

    const room = roomResult.rows[0];

    if (room.status !== 'waiting') {
      return res.status(400).json({ message: "Cannot join room - game already started" });
    }

    // Check if player count < 8
    const playerCountResult = await pool.query(
      "SELECT COUNT(*) FROM room_players WHERE room_id = $1",
      [roomId]
    );

    if (parseInt(playerCountResult.rows[0].count) >= 8) {
      return res.status(400).json({ message: "Room is full" });
    }

    // Add player to room
    await pool.query(
      "INSERT INTO room_players (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [roomId, userId]
    );

    res.json({ message: "Joined room successfully" });
  } catch (error) {
    console.error("Join room error:", error);
    res.status(500).json({ message: "Server error" });
  }
}

async function handleLeaveRoom(req, res, userId, roomId) {
  try {
    // Remove player from room
    await pool.query(
      "DELETE FROM room_players WHERE room_id = $1 AND user_id = $2",
      [roomId, userId]
    );

    // Check if room is now empty
    const playerCountResult = await pool.query(
      "SELECT COUNT(*) FROM room_players WHERE room_id = $1",
      [roomId]
    );

    if (parseInt(playerCountResult.rows[0].count) === 0) {
      // Delete room if empty
      await pool.query("DELETE FROM rooms WHERE id = $1", [roomId]);
    } else {
      // Check if leaving player was host
      const roomResult = await pool.query(
        "SELECT host_id FROM rooms WHERE id = $1",
        [roomId]
      );

      if (roomResult.rows.length > 0 && roomResult.rows[0].host_id === userId) {
        // Assign new random host
        const newHostResult = await pool.query(
          "SELECT user_id FROM room_players WHERE room_id = $1 LIMIT 1",
          [roomId]
        );

        if (newHostResult.rows.length > 0) {
          await pool.query(
            "UPDATE rooms SET host_id = $1 WHERE id = $2",
            [newHostResult.rows[0].user_id, roomId]
          );
        }
      }
    }

    res.json({ message: "Left room successfully" });
  } catch (error) {
    console.error("Leave room error:", error);
    res.status(500).json({ message: "Server error" });
  }
}

async function handleStartGame(req, res, userId, roomId) {
  try {
    // Verify user is host
    const roomResult = await pool.query(
      "SELECT * FROM rooms WHERE id = $1 AND host_id = $2",
      [roomId, userId]
    );

    if (roomResult.rows.length === 0) {
      return res.status(403).json({ message: "Only the host can start the game" });
    }

    const room = roomResult.rows[0];

    if (room.status !== 'waiting') {
      return res.status(400).json({ message: "Game has already started" });
    }

    // Check minimum player count
    const playerCountResult = await pool.query(
      "SELECT COUNT(*) FROM room_players WHERE room_id = $1",
      [roomId]
    );

    if (parseInt(playerCountResult.rows[0].count) < 2) {
      return res.status(400).json({ message: "Need at least 2 players to start" });
    }

    // Get random prompt
    const promptResult = await pool.query(
      "SELECT * FROM prompts ORDER BY RANDOM() LIMIT 1"
    );

    // Start game
    await pool.query(
      `UPDATE rooms SET 
        status = 'playing',
        current_round = 1,
        current_phase = 'drawing',
        current_prompt_id = $1,
        phase_end_time = NOW() + (drawing_time * INTERVAL '1 second')
      WHERE id = $2`,
      [promptResult.rows[0].id, roomId]
    );

    res.json({ message: "Game started successfully" });
  } catch (error) {
    console.error("Start game error:", error);
    res.status(500).json({ message: "Server error" });
  }
}

async function handleGetRoom(req, res, roomId) {
  try {
    const roomResult = await pool.query(
      `SELECT r.*, p.text as prompt_text,
              ARRAY_AGG(json_build_object('id', u.id, 'username', u.username)) as players
       FROM rooms r
       LEFT JOIN prompts p ON r.current_prompt_id = p.id
       LEFT JOIN room_players rp ON r.id = rp.room_id
       LEFT JOIN users u ON rp.user_id = u.id
       WHERE r.id = $1
       GROUP BY r.id, p.text`,
      [roomId]
    );

    if (roomResult.rows.length === 0) {
      return res.status(404).json({ message: "Room not found" });
    }

    res.json(roomResult.rows[0]);
  } catch (error) {
    console.error("Get room error:", error);
    res.status(500).json({ message: "Server error" });
  }
}
