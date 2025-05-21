const { pool } = require("./_config/db");
const { authenticateToken } = require("./_middleware/auth");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const formidable = require('formidable');
const { Storage } = require('@google-cloud/storage');

const storage = new Storage({
  projectId: process.env.GOOGLE_CLOUD_PROJECT_ID,
  credentials: JSON.parse(process.env.GOOGLE_CLOUD_CREDENTIALS),
});

const bucket = storage.bucket(process.env.GOOGLE_CLOUD_BUCKET);

export const config = {
  api: {
    bodyParser: false,
  },
};

// Common helper to parse formData if needed
async function parseFormData(req) {
  const form = formidable();
  return new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) reject(err);
      resolve({ fields, files });
    });
  });
}

export default async function handler(req, res) {
  try {
    // Parse URL path to determine handler
    const path = req.url.split('?')[0];
    const parts = path.split('/').filter(Boolean);
    const base = parts[0]; // 'auth', 'rooms', or 'game'
    const action = req.query.action;
    const id = parts[1]; // roomId or other identifier

    // Handle authentication for protected routes
    if (base !== 'auth' || (action && action !== 'login' && action !== 'register')) {
      const authResult = await authenticateToken(req);
      if (authResult.status) {
        return res.status(authResult.status).json({ message: authResult.message });
      }
      req.user = authResult.user;
    }

    // Route to appropriate handler
    switch (base) {
      case 'auth':
        return handleAuth(req, res, action);
      case 'rooms':
        return handleRooms(req, res, action, id);
      case 'game':
        return handleGame(req, res, action, id);
      default:
        return res.status(404).json({ message: 'Route not found' });
    }
  } catch (error) {
    console.error("API error:", error);
    return res.status(500).json({ message: "Server error" });
  }
}

// Import handlers from our existing files
const { 
  handleLogin,
  handleRegister,
  handleMe,
  handleProfile,
  handlePassword,
} = require('./auth');

const {
  handleListRooms,
  handleCreateRoom,
  handleJoinRoom,
  handleLeaveRoom,
  handleStartGame,
  handleGetRoom,
} = require('./rooms');

const {
  handleGameState,
  handleSubmitDrawing,
  handleDrawingToVote,
  handleVote,
  handleLeaderboard,
} = require('./game');

async function handleAuth(req, res, action) {
  switch (action) {
    case 'login':
      return handleLogin(req, res);
    case 'register':
      return handleRegister(req, res);
    case 'me':
      return handleMe(req, res);
    case 'profile':
      return handleProfile(req, res);
    case 'password':
      return handlePassword(req, res);
    default:
      return res.status(404).json({ message: 'Action not found' });
  }
}

async function handleRooms(req, res, action, roomId) {
  // For rooms, we have both action-based and method-based routing
  if (!action && !roomId) {
    if (req.method === 'GET') return handleListRooms(req, res);
    if (req.method === 'POST') return handleCreateRoom(req, res, req.user.id);
  }

  if (roomId) {
    switch (action) {
      case 'join':
        return handleJoinRoom(req, res, req.user.id, roomId);
      case 'leave':
        return handleLeaveRoom(req, res, req.user.id, roomId);
      case 'start':
        return handleStartGame(req, res, req.user.id, roomId);
      default:
        if (req.method === 'GET') return handleGetRoom(req, res, roomId);
        return res.status(404).json({ message: 'Action not found' });
    }
  }

  return res.status(404).json({ message: 'Route not found' });
}

async function handleGame(req, res, action, roomId) {
  switch (action) {
    case 'state':
      return handleGameState(req, res, req.user.id, roomId);
    case 'submit-drawing':
      return handleSubmitDrawing(req, res, req.user.id, roomId);
    case 'drawing-to-vote':
      return handleDrawingToVote(req, res, req.user.id, roomId);
    case 'vote':
      return handleVote(req, res, req.user.id);
    case 'leaderboard':
      return handleLeaderboard(req, res, roomId);
    default:
      return res.status(404).json({ message: 'Action not found' });
  }
}
