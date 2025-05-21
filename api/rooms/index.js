const { authenticateToken } = require("../_middleware/auth");
const { pool } = require("../_config/db");

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return await handleGet(req, res);
  } else if (req.method === 'POST') {
    return await handlePost(req, res);
  }
  return res.status(405).json({ message: 'Method not allowed' });
}

async function handleGet(req, res) {

  try {
    const authResult = await authenticateToken(req);
    
    if (authResult.status) {
      return res.status(authResult.status).json({ message: authResult.message });
    }

    const result = await pool.query(
      `SELECT r.id, r.name, r.host_id, r.max_players, r.status, r.is_private,
              u.username as host_name,
              COUNT(DISTINCT rp.user_id) as player_count
       FROM rooms r
       JOIN users u ON r.host_id = u.id
       LEFT JOIN room_players rp ON r.id = rp.room_id
       WHERE r.is_private = false
       GROUP BY r.id, u.username
       ORDER BY r.created_at DESC`
    );

    const rooms = result.rows.map((room) => ({
      id: room.id,
      name: room.name,
      host: room.host_name,
      hostId: room.host_id,
      players: Number.parseInt(room.player_count),
      maxPlayers: room.max_players,
      status: room.status,
      isPrivate: room.is_private,
    }));

    res.json(rooms);
  } catch (error) {
    console.error("Get rooms error:", error);
    res.status(500).json({ message: "Server error" });
  }
}

async function handlePost(req, res) {
  try {
    const authResult = await authenticateToken(req);
    
    if (authResult.status) {
      return res.status(authResult.status).json({ message: authResult.message });
    }

    const { name, maxPlayers, drawingTime, votingTime, rounds, isPrivate } = req.body;
    const userId = authResult.user.id;

    // Validate input
    if (!name) {
      return res.status(400).json({ message: "Room name is required" });
    }

    // Generate a unique room code (6 characters)
    const roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();

    // Use explicit fallback only if undefined/null, not if 0
    const safeMaxPlayers = typeof maxPlayers === 'number' && maxPlayers > 0 ? maxPlayers : 6;
    const safeDrawingTime = typeof drawingTime === 'number' && drawingTime > 0 ? drawingTime : 120;
    const safeVotingTime = typeof votingTime === 'number' && votingTime > 0 ? votingTime : 20;
    const safeRounds = typeof rounds === 'number' && rounds > 0 ? rounds : 3;
    const safeIsPrivate = typeof isPrivate === 'boolean' ? isPrivate : false;

    const roomResult = await pool.query(
      `INSERT INTO rooms (
        id, name, host_id, max_players, drawing_time, voting_time, rounds, is_private, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        roomCode,
        name,
        userId,
        safeMaxPlayers,
        safeDrawingTime,
        safeVotingTime,
        safeRounds,
        safeIsPrivate,
        "waiting",
      ]
    );

    const room = roomResult.rows[0];

    // Add host as a player
    await pool.query(
      "INSERT INTO room_players (room_id, user_id) VALUES ($1, $2)",
      [room.id, userId]
    );

    res.status(201).json({
      id: room.id,
      name: room.name,
      hostId: room.host_id,
      maxPlayers: room.max_players,
      drawingTime: room.drawing_time,
      votingTime: room.voting_time,
      rounds: room.rounds,
      isPrivate: room.is_private,
      status: room.status,
    });
  } catch (error) {
    console.error("Create room error:", error);
    res.status(500).json({ message: "Server error" });
  }
}
