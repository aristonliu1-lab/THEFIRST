const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
 
const PORT = process.env.PORT || 3000;
 
const server = http.createServer((req, res) => {
  const filePath = path.join(__dirname, 'index.html');
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(data);
  });
});
 
const wss = new WebSocket.Server({ server });
 
// ── World state ──
const CHUNK_SIZE = 16, WORLD_HEIGHT = 32;
const chunks = new Map();   // key -> Uint8Array
const blockChanges = new Map(); // "x,y,z" -> blockId  (authoritative overrides)
const players = new Map();  // ws -> player object
 
let nextId = 1;
 
// ── Noise helpers (same as client) ──
function noise2D(x, z, seed = 0) {
  let v = 0, amp = 1, freq = 1, max = 0, s = seed * 7.3;
  for (let o = 0; o < 6; o++) {
    v += Math.sin(x * freq * 0.07 + s + Math.cos(z * freq * 0.09 + s)) *
         Math.cos(z * freq * 0.07 + s + Math.sin(x * freq * 0.11 + s)) * amp;
    max += amp; amp *= 0.5; freq *= 2.1;
  }
  return v / max;
}
function noise3D(x, y, z, seed = 42) {
  return Math.sin(x * 0.3 + seed) * Math.cos(y * 0.4 + seed + 1) * Math.sin(z * 0.35 + seed + 2) * 0.5 + 0.5;
}
function getBiome(wx, wz) {
  const t = noise2D(wx, wz, 100), h = noise2D(wx, wz, 200);
  if (t > 0.35) return 'desert';
  if (t < -0.35) return 'snow';
  if (h > 0.3 && t > 0.05) return 'jungle';
  if (noise2D(wx, wz, 300) > 0.4) return 'mountain';
  return 'plains';
}
function getHeight(wx, wz) {
  const b = getBiome(wx, wz), base = 10, n = noise2D(wx, wz, 0), n2 = noise2D(wx * 2, wz * 2, 50);
  switch (b) {
    case 'mountain': return Math.floor(base + (n * 0.6 + n2 * 0.4) * 18 + 8);
    case 'desert': return Math.floor(base + n * 4 + 3);
    case 'snow': return Math.floor(base + n * 10 + 5);
    case 'jungle': return Math.floor(base + n * 6 + 2);
    default: return Math.floor(base + n * 7 + 2);
  }
}
 
function chunkKey(cx, cz) { return `${cx},${cz}`; }
 
function generateChunk(cx, cz) {
  const data = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE * WORLD_HEIGHT);
  const idx = (x, y, z) => x + z * CHUNK_SIZE + y * CHUNK_SIZE * CHUNK_SIZE;
  for (let lx = 0; lx < CHUNK_SIZE; lx++) for (let lz = 0; lz < CHUNK_SIZE; lz++) {
    const wx = cx * CHUNK_SIZE + lx, wz = cz * CHUNK_SIZE + lz;
    const biome = getBiome(wx, wz), h = Math.min(getHeight(wx, wz), WORLD_HEIGHT - 2);
    for (let y = 0; y <= h; y++) {
      let block;
      if (y === h) block = biome === 'desert' ? 4 : biome === 'snow' ? 5 : 1;
      else if (y >= h - 3) block = biome === 'desert' ? 4 : biome === 'snow' ? 6 : 2;
      else {
        const on = noise3D(wx, y, wz, 7);
        if (y < 5 && on > 0.82) block = 12;
        else if (y < 10 && on > 0.78) block = 11;
        else if (y < 18 && on > 0.74) block = 9;
        else if (on > 0.70) block = 10;
        else if (noise3D(wx, y, wz, 99) > 0.88) block = 18;
        else block = 3;
      }
      data[idx(lx, y, lz)] = block;
    }
    if (h < 8) for (let y = h + 1; y <= 8; y++) data[idx(lx, y, lz)] = 13;
    // Trees
    const tn = noise2D(wx * 3, wz * 3, 99);
    if (tn > 0.75 && h > 8) {
      const type = biome === 'jungle' ? 'jungle' : biome === 'snow' ? 'pine' : 'oak';
      placeTree(data, idx, lx, h + 1, lz, type);
    }
    if (biome === 'desert' && tn > 0.8 && h >= 8) {
      const ch = Math.floor(tn * 3) + 2;
      for (let y = h + 1; y <= h + ch && y < WORLD_HEIGHT - 1; y++) data[idx(lx, y, lz)] = 16;
    }
  }
  return data;
}
 
function placeTree(data, idx, lx, sy, lz, type) {
  const wood = type === 'jungle' ? 14 : type === 'pine' ? 20 : 7;
  const leaf = type === 'jungle' ? 15 : type === 'pine' ? 21 : 8;
  const trunk = type === 'jungle' ? 7 : type === 'pine' ? 6 : 5;
  for (let y = 0; y < trunk; y++) {
    if (sy + y >= WORLD_HEIGHT) return;
    if (lx >= 0 && lx < CHUNK_SIZE && lz >= 0 && lz < CHUNK_SIZE) data[idx(lx, sy + y, lz)] = wood;
  }
  const top = sy + trunk;
  for (let dy = -1; dy <= 2; dy++) for (let dlx = -2; dlx <= 2; dlx++) for (let dlz = -2; dlz <= 2; dlz++) {
    if (dlx === 0 && dlz === 0 && dy < 2) continue;
    if (Math.abs(dlx) + Math.abs(dlz) + (dy < 0 ? 1 : 0) > 3) continue;
    const nx = lx + dlx, ny = top + dy, nz = lz + dlz;
    if (nx >= 0 && nx < CHUNK_SIZE && nz >= 0 && nz < CHUNK_SIZE && ny < WORLD_HEIGHT && ny >= 0 && data[idx(nx, ny, nz)] === 0)
      data[idx(nx, ny, nz)] = leaf;
  }
}
 
function getChunkData(cx, cz) {
  const k = chunkKey(cx, cz);
  if (!chunks.has(k)) chunks.set(k, generateChunk(cx, cz));
  return chunks.get(k);
}
 
function getBlock(wx, wy, wz) {
  // Check authoritative block changes first
  const bk = `${wx},${wy},${wz}`;
  if (blockChanges.has(bk)) return blockChanges.get(bk);
  if (wy < 0 || wy >= WORLD_HEIGHT) return 0;
  const cx = Math.floor(wx / CHUNK_SIZE), cz = Math.floor(wz / CHUNK_SIZE);
  const lx = ((wx % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE, lz = ((wz % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
  return getChunkData(cx, cz)[lx + lz * CHUNK_SIZE + wy * CHUNK_SIZE * CHUNK_SIZE];
}
 
function findSpawn() {
  for (let x = -5; x <= 5; x++) for (let z = -5; z <= 5; z++)
    for (let y = WORLD_HEIGHT - 1; y > 0; y--) {
      const b = getBlock(x, y, z);
      if (b && b !== 13) return { x: x + 0.5, y: y + 3, z: z + 0.5 };
    }
  return { x: 0.5, y: 18, z: 0.5 };
}
 
function broadcast(data, exclude = null) {
  const msg = JSON.stringify(data);
  for (const [ws] of players) {
    if (ws !== exclude && ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}
 
function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}
 
// ── Day/Night cycle (server authoritative) ──
let serverDayTime = 0.25; // start at noon
const DAY_DURATION = 300; // seconds per full cycle
let lastTick = Date.now();
 
setInterval(() => {
  const now = Date.now();
  const dt = (now - lastTick) / 1000;
  lastTick = now;
  serverDayTime = (serverDayTime + dt / DAY_DURATION) % 1;
  // Broadcast to all players every second
  broadcast({ type: 'timeSync', dayTime: serverDayTime });
}, 1000);
 
// Pre-generate spawn chunks
console.log('Generating spawn chunks...');
for (let cx = -3; cx <= 3; cx++) for (let cz = -3; cz <= 3; cz++) getChunkData(cx, cz);
console.log('Done. Server ready.');
 
wss.on('connection', (ws) => {
  const id = nextId++;
  const spawn = findSpawn();
  const player = {
    id, name: `Player${id}`,
    x: spawn.x, y: spawn.y, z: spawn.z,
    yaw: 0, pitch: 0,
    health: 10,
  };
  players.set(ws, player);
  console.log(`Player ${id} connected. Total: ${players.size}`);
 
  // Send this player their ID and all current players
  send(ws, { type: 'welcome', id, spawn, players: [...players.values()].filter(p => p.id !== id), dayTime: serverDayTime });
 
  // Send all block changes so far
  if (blockChanges.size > 0) {
    const changes = [];
    for (const [k, v] of blockChanges) {
      const [x, y, z] = k.split(',').map(Number);
      changes.push({ x, y, z, block: v });
    }
    send(ws, { type: 'blockBatch', changes });
  }
 
  // Tell others about new player (with spawn position)
  broadcast({ type: 'playerJoin', player: { id: player.id, name: player.name, x: player.x, y: player.y, z: player.z, yaw: 0, hp: 10 } }, ws);
 
  // Send new player the current positions of all existing players
  for (const [ows, op] of players) {
    if (ows === ws) continue;
    send(ws, { type: 'playerMove', id: op.id, x: op.x, y: op.y, z: op.z, yaw: op.yaw||0, pitch: op.pitch||0 });
  }
 
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
 
    switch (msg.type) {
      case 'move': {
        const p = players.get(ws);
        if (!p) return;
        p.x = msg.x; p.y = msg.y; p.z = msg.z;
        p.yaw = msg.yaw; p.pitch = msg.pitch;
        broadcast({ type: 'playerMove', id: p.id, x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch }, ws);
        break;
      }
      case 'blockSet': {
        const { x, y, z, block } = msg;
        const bk = `${x},${y},${z}`;
        if (block === 0) blockChanges.set(bk, 0);
        else blockChanges.set(bk, block);
        // Also update chunk data
        const cx = Math.floor(x / CHUNK_SIZE), cz = Math.floor(z / CHUNK_SIZE);
        const lx = ((x % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE, lz = ((z % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
        const data = getChunkData(cx, cz);
        data[lx + lz * CHUNK_SIZE + y * CHUNK_SIZE * CHUNK_SIZE] = block;
        broadcast({ type: 'blockSet', x, y, z, block });
        break;
      }
      case 'hitPlayer': {
        const attacker = players.get(ws);
        if (!attacker) return;
        const targetWs = [...players.entries()].find(([w,p])=>p.id===msg.targetId)?.[0];
        if (!targetWs) return;
        const target = players.get(targetWs);
        if (!target) return;
        target.health = Math.max(0, target.health - (msg.damage||1));
        // Tell everyone the target's new HP
        broadcast({ type: 'playerHit', id: target.id, hp: target.health });
        // Tell the target they were hit
        send(targetWs, { type: 'youWereHit', damage: msg.damage||1, attackerId: attacker.id });
        if (target.health <= 0) {
          // Player died
          broadcast({ type: 'playerDied', id: target.id, killerName: attacker.name });
          // Respawn after 3 seconds
          const spawn = findSpawn();
          target.health = 10;
          target.x = spawn.x; target.y = spawn.y; target.z = spawn.z;
          setTimeout(() => {
            send(targetWs, { type: 'forceRespawn', spawn });
            broadcast({ type: 'playerRespawn', id: target.id }, targetWs);
          }, 3000);
        }
        break;
      }
      case 'chat': {
        const p = players.get(ws);
        if (!p) return;
        const text = String(msg.text).slice(0, 120);
        broadcast({ type: 'chat', id: p.id, name: p.name, text });
        break;
      }
      case 'setName': {
        const p = players.get(ws);
        if (!p) return;
        p.name = String(msg.name).slice(0, 20).replace(/[<>]/g, '');
        broadcast({ type: 'playerName', id: p.id, name: p.name });
        break;
      }
    }
  });
 
  ws.on('close', () => {
    const p = players.get(ws);
    if (p) {
      broadcast({ type: 'playerLeave', id: p.id });
      console.log(`Player ${p.id} disconnected. Total: ${players.size - 1}`);
    }
    players.delete(ws);
  });
 
  ws.on('error', () => players.delete(ws));
});
 
server.listen(PORT, () => console.log(`BlockCraft server running on port ${PORT}`));
