const { authenticateToken } = require("../../_middleware/auth");
const { pool } = require("../../_config/db");
const cloudinary = require("cloudinary").v2;
const multer = require("multer");
const { CloudinaryStorage } = require("multer-storage-cloudinary");

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Configure multer with Cloudinary storage
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: "drawbattle",
    format: async (req, file) => "png",
    public_id: (req, file) => `${req.query.roomId}-${Date.now()}`,
  },
});

const upload = multer({ storage: storage });

export const config = {
  api: {
    bodyParser: false, // Disable bodyParser for file uploads
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    // Handle authentication first
    const authResult = await authenticateToken(req);
    
    if (authResult.status) {
      return res.status(authResult.status).json({ message: authResult.message });
    }

    const userId = authResult.user.id;
    const { roomId } = req.query;

    // Process file upload using multer
    await new Promise((resolve, reject) => {
      upload.single("drawing")(req, res, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // Check if room exists and is in drawing phase
    const roomResult = await pool.query(
      "SELECT * FROM rooms WHERE id = $1 AND current_phase = $2",
      [roomId, "drawing"]
    );

    if (roomResult.rows.length === 0) {
      return res.status(400).json({ message: "Room not found or not in drawing phase" });
    }

    const room = roomResult.rows[0];

    // Check if user is in the room and revalidate session if needed
    const playerResult = await pool.query(
      "SELECT * FROM room_players WHERE room_id = $1 AND user_id = $2",
      [roomId, userId]
    );

    if (playerResult.rows.length === 0) {
      // Try to automatically rejoin if game is in progress
      const wasInRoomResult = await pool.query(
        "SELECT 1 FROM drawings WHERE room_id = $1 AND artist_id = $2 AND round_number < $3",
        [roomId, userId, room.current_round]
      );
      
      if (wasInRoomResult.rows.length > 0) {
        await pool.query(
          "INSERT INTO room_players (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
          [roomId, userId]
        );
      } else {
        return res.status(403).json({ message: "You are not in this room" });
      }
    }

    // Check if user has already submitted a drawing for this round
    const existingDrawingResult = await pool.query(
      "SELECT * FROM drawings WHERE room_id = $1 AND round_number = $2 AND artist_id = $3",
      [roomId, room.current_round, userId]
    );

    if (existingDrawingResult.rows.length > 0) {
      return res.status(400).json({ message: "You have already submitted a drawing for this round" });
    }

    // Get the image URL from Cloudinary
    if (!req.file || !req.file.path) {
      return res.status(400).json({ message: "No drawing image provided" });
    }

    const imageUrl = req.file.path;

    // Save drawing to database
    await pool.query(
      `INSERT INTO drawings (
        room_id, round_number, prompt_id, artist_id, image_url
      ) VALUES ($1, $2, $3, $4, $5)`,
      [roomId, room.current_round, room.current_prompt_id, userId, imageUrl]
    );

    // Check if all players have submitted drawings
    const playerCountResult = await pool.query(
      "SELECT COUNT(*) FROM room_players WHERE room_id = $1",
      [roomId]
    );

    const drawingCountResult = await pool.query(
      "SELECT COUNT(*) FROM drawings WHERE room_id = $1 AND round_number = $2",
      [roomId, room.current_round]
    );

    const playerCount = Number.parseInt(playerCountResult.rows[0].count);
    const drawingCount = Number.parseInt(drawingCountResult.rows[0].count);

    // If all players have submitted, move to voting phase
    if (drawingCount >= playerCount) {
      await pool.query(
        `UPDATE rooms SET 
          current_phase = 'voting', 
          current_drawing_index = 0,
          phase_end_time = NOW() + (voting_time * INTERVAL '1 second')
        WHERE id = $1`,
        [roomId]
      );
    }

    res.json({ message: "Drawing submitted successfully" });
  } catch (error) {
    console.error("Submit drawing error:", error);
    res.status(500).json({ message: "Server error" });
  }
}
