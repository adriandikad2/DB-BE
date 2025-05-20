-- Create users table
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create rooms table
CREATE TABLE rooms (
    id VARCHAR(6) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    host_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    max_players INTEGER DEFAULT 6,
    drawing_time INTEGER DEFAULT 60,
    voting_time INTEGER DEFAULT 15,
    rounds INTEGER DEFAULT 3,
    is_private BOOLEAN DEFAULT FALSE,
    status VARCHAR(20) DEFAULT 'waiting',
    current_round INTEGER DEFAULT 0,
    current_phase VARCHAR(20) DEFAULT NULL,
    current_prompt_id INTEGER DEFAULT NULL,
    current_drawing_index INTEGER DEFAULT 0,
    phase_end_time TIMESTAMP DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create room_players table (many-to-many relationship)
CREATE TABLE room_players (
    room_id VARCHAR(6) REFERENCES rooms(id),
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (room_id, user_id)
);

-- Create prompts table
CREATE TABLE prompts (
    id SERIAL PRIMARY KEY,
    text VARCHAR(255) NOT NULL,
    category VARCHAR(50) DEFAULT 'general',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create drawings table
CREATE TABLE drawings (
    id SERIAL PRIMARY KEY,
    room_id VARCHAR(6) REFERENCES rooms(id) ON DELETE CASCADE,
    round_number INTEGER NOT NULL,
    prompt_id INTEGER REFERENCES prompts(id),
    artist_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    image_url TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create stars table
CREATE TABLE stars (
    id SERIAL PRIMARY KEY,
    drawing_id INTEGER REFERENCES drawings(id) ON DELETE CASCADE,
    voter_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (drawing_id, voter_id)
);

-- Create game_results table to store final standings
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
