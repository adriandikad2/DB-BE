const express = require("express")
const cors = require("cors")
const morgan = require("morgan")
const dotenv = require("dotenv")
const { v4: uuidv4 } = require("uuid")
const path = require("path")

// Load environment variables
dotenv.config()

// Import routes
const authRoutes = require("./routes/auth")
const roomRoutes = require("./routes/rooms")
const gameRoutes = require("./routes/game")

// Import database connection
const { pool } = require("./config/db")

// Create Express app
const app = express()
const PORT = process.env.PORT || 5000

app.use(cors({
  origin: function (origin, callback) {
    console.log("CORS origin:", origin); // Add this
    const allowedOrigins = [
      "https://drawbattle.vercel.app",
      "http://localhost:5173"
    ];
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
}));

app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(morgan("dev"))

// API routes
app.use("/api/auth", authRoutes)
app.use("/api/rooms", roomRoutes)
app.use("/api/game", gameRoutes)

// Root endpoint
app.get("/", (req, res) => res.send("Hello World!"))

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.status(200).json({ status: "ok", message: "Server is running" })
})

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack)
  res.status(500).json({
    message: "Something went wrong!",
    error: process.env.NODE_ENV === "production" ? {} : err,
  })
})

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})

// Test database connection
pool.query("SELECT NOW()", (err, res) => {
  if (err) {
    console.error("Database connection error:", err.stack)
  } else {
    console.log("Database connected:", res.rows[0])
  }
})

// Function to check and update game phases
const checkGamePhases = async () => {
  try {
    // Find rooms where phase has ended (current time > phase_end_time)
    const expiredPhasesResult = await pool.query(
      `SELECT r.*, 
              (SELECT COUNT(*) FROM drawings WHERE room_id = r.id AND round_number = r.current_round) as total_drawings
       FROM rooms r
       WHERE r.status = 'playing' 
       AND r.phase_end_time < NOW()
       AND r.phase_end_time IS NOT NULL`
    );

    for (const room of expiredPhasesResult.rows) {
      console.log(`Processing room ${room.id} phase transition from ${room.current_phase}`);
      
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
          console.log(`Room ${room.id}: Drawing phase ended, moved to voting phase`);
        } 
        else if (room.current_phase === 'voting') {
          // Get latest value for total drawings to ensure accuracy
          const drawingsResult = await pool.query(
            "SELECT COUNT(*) FROM drawings WHERE room_id = $1 AND round_number = $2",
            [room.id, room.current_round]
          );
          
          const totalDrawings = parseInt(drawingsResult.rows[0].count);
          console.log(`Room ${room.id}: Total drawings: ${totalDrawings}, Current index: ${room.current_drawing_index}`);
          
          // Check for zero drawings edge case
          if (totalDrawings === 0) {
            // No drawings in this round, move to next round or end game
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
              console.log(`Room ${room.id}: Game completed, moved to results (no drawings)`);
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
              console.log(`Room ${room.id}: Round ${room.current_round} completed (no drawings), moved to next round`);
            }
          }
          // If we've voted on all drawings
          else if (room.current_drawing_index >= totalDrawings - 1) {
            // Last drawing in voting phase
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
              console.log(`Room ${room.id}: Game completed, moved to results`);
            } else {
              // Move to next round
              // Select a new prompt
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
              console.log(`Room ${room.id}: Round ${room.current_round} completed, moved to next round`);
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
            console.log(`Room ${room.id}: Moved to next drawing for voting (${room.current_drawing_index + 1}/${totalDrawings})`);
          }
        }
      } catch (phaseError) {
        console.error(`Error processing phase transition for room ${room.id}:`, phaseError);
        
        // Try to recover the room if possible
        try {
          // Check if the room is in a potentially stuck state
          const roomCheck = await pool.query("SELECT * FROM rooms WHERE id = $1", [room.id]);
          
          if (roomCheck.rows.length > 0) {
            const checkRoom = roomCheck.rows[0];
            
            // If the room didn't change state after our error, try to fix it
            if (checkRoom.current_phase === room.current_phase) {
              console.log(`Attempting to recover room ${room.id} from stuck state`);
              
              // Set a new phase end time 30 seconds in the future to give time to recover
              await pool.query(
                `UPDATE rooms SET 
                  phase_end_time = NOW() + INTERVAL '30 seconds'
                WHERE id = $1`,
                [room.id]
              );
              console.log(`Reset phase timer for room ${room.id} to recover from error`);
            }
          }
        } catch (recoveryError) {
          console.error(`Failed to recover room ${room.id}:`, recoveryError);
        }
      }
    }
  } catch (error) {
    console.error("Error checking game phases:", error);
  }
};

// Run the game phase check every 2 seconds
setInterval(checkGamePhases, 2000);
