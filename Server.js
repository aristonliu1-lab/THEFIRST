const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 2000,
  pingTimeout: 5000,
});

app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────
// World state
// ─────────────────────────────────────────────
const CHUNK_SIZE = 16;
const WORLD_HEIGHT = 32;

// Store block modifications (only changes from generated terrain)
const blockChanges = new Map(); // "wx,wy,wz" -> blockType

function blockKey(x, y, z) { return `${x},${y},${z}`; }

// ─────────────────────────────────────────────
// Players
// ─────────────────────────────────────────────
const players = new Map(); // socketId -> { id, name, x, y, z, yaw, pitch, color }

const PLAYER_COLORS = [
  '#ff4444','#44aaff','#ffaa00','#44ff88','#ff44cc',
  '#00ffff','#ff8800','#88ff00','#ff0088','#8844ff'
];
let colorIdx = 0;

function getColor() {
  const c = PLAYER_COLORS[colorIdx % PLAYER_COLORS.length];
  colorIdx++;
  return c;
}

// ─────────────────────────────────────────────
// Socket.io
// ─────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  // Send existing world changes and all current players to new player
  socket.emit('world_state', {
    blockChanges: Object.fromEntries(blockChanges),
    players: Array.from(players.values()),
  });

  // Register new player
  socket.on('join', (data) => {
    const player = {
      id: socket.id,
      name: data.name || `Player${Math.floor(Math.random()*1000)}`,
      x: data.x || 8, y: data.y || 20, z: data.z || 8,
      yaw: 0, pitch: 0,
      color: getColor(),
    };
    players.set(socket.id, player);

    // Tell this player their own info
    socket.emit('self_info', { id: socket.id, color: player.color, name: player.name });

    // Tell everyone else about the new player
    socket.broadcast.emit('player_joined', player);

    console.log(`${player.name} joined. Total players: ${players.size}`);
  });

  // Player movement sync (throttled by client)
  socket.on('move', (data) => {
    const p = players.get(socket.id);
    if (!p) return;
    p.x = data.x; p.y = data.y; p.z = data.z;
    p.yaw = data.yaw; p.pitch = data.pitch;
    // Broadcast to everyone except sender
    socket.broadcast.emit('player_moved', {
      id: socket.id, x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch
    });
  });

  // Block broken
  socket.on('break_block', (data) => {
    const { x, y, z } = data;
    const key = blockKey(x, y, z);
    blockChanges.set(key, 0); // 0 = AIR
    // Broadcast to ALL including sender confirmation
    io.emit('block_changed', { x, y, z, type: 0, by: socket.id });
    console.log(`Block broken at ${x},${y},${z}`);
  });

  // Block placed
  socket.on('place_block', (data) => {
    const { x, y, z, type } = data;
    const key = blockKey(x, y, z);
    blockChanges.set(key, type);
    io.emit('block_changed', { x, y, z, type, by: socket.id });
    console.log(`Block placed (${type}) at ${x},${y},${z}`);
  });

  // Chat message
  socket.on('chat', (data) => {
    const p = players.get(socket.id);
    if (!p) return;
    const msg = String(data.msg || '').slice(0, 120);
    io.emit('chat_msg', { name: p.name, color: p.color, msg });
  });

  // Disconnect
  socket.on('disconnect', () => {
    const p = players.get(socket.id);
    if (p) {
      console.log(`${p.name} left.`);
      io.emit('player_left', { id: socket.id, name: p.name });
    }
    players.delete(socket.id);
  });
});

// ─────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`BlockCraft server running on port ${PORT}`);
});
