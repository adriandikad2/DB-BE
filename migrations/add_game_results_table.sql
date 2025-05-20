-- Add game_results table to store final standings
CREATE TABLE game_results (
    id SERIAL PRIMARY KEY,
    room_id VARCHAR(6) REFERENCES rooms(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    username VARCHAR(50) NOT NULL,
    score INTEGER NOT NULL,
    rank INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (room_id, user_id)
);
