'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { WebSocket, WebSocketServer } = require('ws');

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const MAX_ROOMS = 200;
const MAX_PLAYERS = 4;
const MAX_PAYLOAD = 65_536;
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const WORLD_WIDTH = 440;
const WORLD_HEIGHT = 920;
const RIVER_WIDTH = WORLD_WIDTH * 0.65;
const RAFT_RADIUS = 40;
const TICK_MS = 50;
const RECONNECT_MS = 30_000;
const PLAYER_COLORS = ['#ffffff', '#f59e0b', '#f472b6', '#f8fafc'];

function getRiverCenterAt(y, distance) {
    const progress = distance - y;
    return 34 * Math.sin(progress * 0.0045) +
        12 * Math.sin(progress * 0.008 + 1.1) -
        12 * Math.sin(1.1);
}

function cleanPlayerName(value) {
    if (typeof value !== 'string') return null;
    const name = value.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 16);
    return name.length >= 2 ? name : null;
}

function createRoomCode(rooms) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        let code = '';
        for (let i = 0; i < 5; i += 1) {
            code += ROOM_CODE_CHARS[crypto.randomInt(ROOM_CODE_CHARS.length)];
        }
        if (!rooms.has(code)) return code;
    }
    throw new Error('Unable to allocate a room code.');
}

function createGameServer(options = {}) {
    const rooms = new Map();
    const resumeTokens = new Map();
    const configuredOrigins = options.allowedOrigins ?? process.env.ALLOWED_ORIGINS ?? '';
    const allowedOrigins = new Set(
        (Array.isArray(configuredOrigins) ? configuredOrigins : configuredOrigins.split(','))
            .map(value => value.trim())
            .filter(Boolean)
            .map(value => {
                const origin = new URL(value);
                if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password) {
                    throw new Error(`Invalid ALLOWED_ORIGINS entry: ${value}`);
                }
                return origin.origin;
            })
    );
    let tickTimer;
    let cleanupTimer;

    function send(socket, type, payload = {}) {
        if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type, ...payload }));
        }
    }

    function sendError(socket, message) {
        send(socket, 'error', { message });
    }

    function connectedPlayers(room) {
        return [...room.players.values()].filter(player => player.connected);
    }

    function publicPlayers(room) {
        const players = [...room.players.values()].sort((a, b) => a.seat - b.seat);
        const sectorSize = (Math.PI * 2) / Math.max(players.length, 1);
        return players.map((player, index) => {
            const seatAngle = -Math.PI / 2 + index * sectorSize;
            return {
                id: player.id,
                name: player.name,
                seat: player.seat,
                angle: player.angle,
                seatAngle,
                sectorStart: seatAngle - sectorSize / 2,
                sectorSize,
                gas: Math.round(player.gas),
                connected: player.connected,
                voiceReady: player.voiceReady,
                isHost: player.id === room.hostId,
                color: PLAYER_COLORS[player.seat]
            };
        });
    }

    function snapshot(room) {
        return {
            code: room.code,
            phase: room.phase,
            score: Math.floor(room.distance),
            crashReason: room.crashReason,
            hostId: room.hostId,
            players: publicPlayers(room),
            raft: { x: room.raft.x, y: room.raft.y, vx: room.raft.vx, vy: room.raft.vy },
            walls: room.walls.map(wall => ({
                y: wall.y,
                height: wall.height,
                gapCenter: wall.gapCenter,
                gapWidth: wall.gapWidth,
                isGate: wall.isGate
            })),
            beans: room.beans.map(bean => ({ x: bean.x, y: bean.y, radius: bean.radius })),
            scrollOffset: room.scrollOffset
        };
    }

    function broadcast(room, type, payload) {
        for (const player of room.players.values()) {
            if (player.socket) send(player.socket, type, payload);
        }
    }

    function broadcastState(room) {
        broadcast(room, 'state', { state: snapshot(room) });
    }

    function removePlayer(room, player) {
        room.players.delete(player.id);
        resumeTokens.delete(player.resumeHash);
        if (room.hostId === player.id) {
            room.hostId = connectedPlayers(room)[0]?.id || [...room.players.keys()][0] || null;
        }
        if (room.players.size === 0) rooms.delete(room.code);
        else broadcastState(room);
    }

    function addPlayer(room, socket, name) {
        if (room.players.size >= MAX_PLAYERS) {
            sendError(socket, 'This room is full.');
            return null;
        }
        const takenSeats = new Set([...room.players.values()].map(player => player.seat));
        const seat = [0, 1, 2, 3].find(candidate => !takenSeats.has(candidate));
        const token = crypto.randomBytes(32).toString('base64url');
        const player = {
            id: crypto.randomUUID(),
            name,
            seat,
            gas: 100,
            angle: 0.5,
            voiceReady: false,
            connected: true,
            socket,
            resumeHash: crypto.createHash('sha256').update(token).digest('hex'),
            expiresAt: null,
            lastFartAt: 0
        };
        room.players.set(player.id, player);
        if (!room.hostId || !room.players.get(room.hostId)?.connected) room.hostId = player.id;
        resumeTokens.set(player.resumeHash, { code: room.code, playerId: player.id });
        socket.session = { id: player.id, name, roomCode: room.code, resumeToken: token };
        return player;
    }

    function sendRoomJoined(socket, room, player) {
        send(socket, 'roomJoined', {
            playerId: player.id,
            resumeToken: socket.session.resumeToken,
            state: snapshot(room)
        });
    }

    function createRoom(socket, name) {
        if (rooms.size >= MAX_ROOMS) {
            sendError(socket, 'The game is full right now. Try again in a moment.');
            return;
        }
        const code = createRoomCode(rooms);
        const room = {
            code,
            phase: 'waiting',
            hostId: null,
            players: new Map(),
            raft: { x: 0, y: 0, vx: 0, vy: 0 },
            walls: [],
            beans: [],
            distance: 0,
            scrollOffset: 0,
            nextWallId: 1,
            crashReason: null
        };
        rooms.set(code, room);
        const player = addPlayer(room, socket, name);
        if (!player) {
            rooms.delete(code);
            return;
        }
        room.hostId = player.id;
        sendRoomJoined(socket, room, player);
        broadcastState(room);
    }

    function resetGame(room) {
        room.phase = 'running';
        room.distance = 0;
        room.crashReason = null;
        room.raft = { x: 0, y: 0, vx: 0, vy: 0 };
        room.walls = [];
        room.beans = [];
        room.scrollOffset = 0;
        room.nextWallId = 1;
        for (const player of room.players.values()) {
            player.gas = 100;
            player.angle = 0.5;
            player.lastFartAt = 0;
        }
        spawnWall(room);
    }

    function startGame(room) {
        if (room.phase !== 'waiting' && room.phase !== 'finished') return false;
        if (connectedPlayers(room).length < 2) return false;
        resetGame(room);
        broadcast(room, 'gameStarted', {});
        broadcastState(room);
        return true;
    }

    function spawnWall(room) {
        const wallY = -320;
        const centerX = getRiverCenterAt(wallY, room.distance);
        const minX = centerX - RIVER_WIDTH / 2 + 25;
        const maxX = centerX + RIVER_WIDTH / 2 - 25;
        const gapWidth = RAFT_RADIUS * 2.8;
        const centerMin = minX + gapWidth / 2;
        const centerMax = maxX - gapWidth / 2;
        const gapCenter = centerMin + Math.random() * (centerMax - centerMin);
        room.walls.push({
            id: room.nextWallId++,
            y: wallY,
            height: 28,
            gapCenter,
            gapWidth,
            isGate: Math.random() > 0.5
        });
        if (Math.random() < 0.65) {
            room.beans.push({ x: gapCenter, y: wallY - 60, radius: 12 });
        }
    }

    function finishGame(room, reason) {
        if (room.phase !== 'running') return;
        room.phase = 'finished';
        room.crashReason = reason;
        broadcast(room, 'crash', { reason });
    }

    function stepRoom(room) {
        if (room.phase !== 'running') return;
        const frameScale = TICK_MS / (1000 / 60);
        room.distance += frameScale;
        room.scrollOffset = (room.scrollOffset + 0.9 * frameScale) % 36;

        for (const player of room.players.values()) {
            if (player.connected) player.gas = Math.min(100, player.gas + 0.25 * frameScale);
        }

        const raftCenterX = getRiverCenterAt(room.raft.y, room.distance);
        room.raft.vx += (raftCenterX - room.raft.x) * 0.0007 * frameScale;
        room.raft.vy += (0.035 - room.raft.y * 0.001) * frameScale;
        room.raft.vx *= Math.pow(0.88, frameScale);
        room.raft.vy *= Math.pow(0.88, frameScale);
        room.raft.x += room.raft.vx * frameScale;
        room.raft.y += room.raft.vy * frameScale;

        const riverCenterX = getRiverCenterAt(room.raft.y, room.distance);
        const maxBorder = RIVER_WIDTH / 2 - RAFT_RADIUS - 18;
        if (room.raft.x < riverCenterX - maxBorder || room.raft.x > riverCenterX + maxBorder) {
            finishGame(room, 'The raft hit the riverbank.');
            return;
        }
        const maxVert = WORLD_HEIGHT / 2 - 100;
        room.raft.y = Math.max(-maxVert, Math.min(maxVert, room.raft.y));

        for (let i = room.walls.length - 1; i >= 0; i -= 1) {
            const wall = room.walls[i];
            wall.y += 0.9 * frameScale;
            if (Math.abs(room.raft.y - wall.y) < RAFT_RADIUS + wall.height / 2) {
                const gapLeft = wall.gapCenter - wall.gapWidth / 2 + RAFT_RADIUS * 0.6;
                const gapRight = wall.gapCenter + wall.gapWidth / 2 - RAFT_RADIUS * 0.6;
                if (room.raft.x < gapLeft || room.raft.x > gapRight) {
                    finishGame(room, 'The raft hit an obstacle.');
                    return;
                }
            }
            if (wall.y > WORLD_HEIGHT / 2 + 150) room.walls.splice(i, 1);
        }

        if (room.walls.length === 0 || room.walls[room.walls.length - 1].y > -110) {
            spawnWall(room);
        }

        for (let i = room.beans.length - 1; i >= 0; i -= 1) {
            const bean = room.beans[i];
            bean.y += 0.9 * frameScale;
            if (Math.hypot(bean.x - room.raft.x, bean.y - room.raft.y) < RAFT_RADIUS + bean.radius) {
                const player = [...room.players.values()].sort((a, b) => a.gas - b.gas)[0];
                if (player) player.gas = Math.min(100, player.gas + 45);
                room.beans.splice(i, 1);
                broadcast(room, 'gasPickup', {});
            } else if (bean.y > WORLD_HEIGHT / 2 + 150) {
                room.beans.splice(i, 1);
            }
        }
    }

    function handleMessage(socket, rawMessage) {
        const now = Date.now();
        const session = socket.session;
        if (now - socket.rateWindow >= 1000) {
            socket.rateWindow = now;
            socket.messageCount = 0;
        }
        socket.messageCount += 1;
        if (socket.messageCount > 60) {
            sendError(socket, 'Too many messages. Please slow down.');
            socket.close(1008, 'Rate limit exceeded');
            return;
        }

        let message;
        try {
            message = JSON.parse(rawMessage.toString());
        } catch {
            sendError(socket, 'Invalid message format.');
            return;
        }
        if (!message || typeof message.type !== 'string') {
            sendError(socket, 'Invalid message format.');
            return;
        }

        if (message.type === 'hello') {
            if (session) {
                sendError(socket, 'You are already connected.');
                return;
            }
            const name = cleanPlayerName(message.name);
            if (!name) {
                sendError(socket, 'Choose a name between 2 and 16 characters.');
                return;
            }
            if (typeof message.resumeToken === 'string' && message.resumeToken.length <= 128) {
                const hash = crypto.createHash('sha256').update(message.resumeToken).digest('hex');
                const saved = resumeTokens.get(hash);
                const room = saved && rooms.get(saved.code);
                const player = room && room.players.get(saved.playerId);
                if (player && (player.connected || player.expiresAt > now)) {
                    player.connected = true;
                    player.expiresAt = null;
                    if (player.socket && player.socket !== socket) player.socket.close(4001, 'Session resumed elsewhere');
                    player.socket = socket;
                    socket.session = { id: player.id, name: player.name, roomCode: room.code, resumeToken: message.resumeToken };
                    send(socket, 'roomJoined', {
                        playerId: player.id,
                        resumeToken: message.resumeToken,
                        resumed: true,
                        state: snapshot(room)
                    });
                    broadcastState(room);
                    return;
                }
            }
            socket.session = { id: crypto.randomUUID(), name, roomCode: null, resumeToken: null };
            send(socket, 'welcome', { playerId: socket.session.id, name });
            return;
        }

        if (!session) {
            sendError(socket, 'Connect to the game first.');
            return;
        }

        if (message.type === 'rename') {
            if (session.roomCode) {
                sendError(socket, 'Leave your room before changing your name.');
                return;
            }
            const name = cleanPlayerName(message.name);
            if (!name) {
                sendError(socket, 'Choose a name between 2 and 16 characters.');
                return;
            }
            session.name = name;
            send(socket, 'renamed', { name });
            return;
        }

        if (message.type === 'createRoom') {
            if (session.roomCode) {
                sendError(socket, 'Leave your current room before creating another.');
                return;
            }
            createRoom(socket, session.name);
            return;
        }

        if (message.type === 'quickMatch') {
            if (session.roomCode) {
                sendError(socket, 'Leave your current room before matchmaking.');
                return;
            }
            let room = [...rooms.values()].find(candidate => candidate.phase === 'waiting' && candidate.players.size < MAX_PLAYERS);
            if (!room) {
                if (rooms.size >= MAX_ROOMS) {
                    sendError(socket, 'Matchmaking is full right now. Try again in a moment.');
                    return;
                }
                const code = createRoomCode(rooms);
                room = {
                    code,
                    phase: 'waiting',
                    hostId: null,
                    players: new Map(),
                    raft: { x: 0, y: 0, vx: 0, vy: 0 },
                    walls: [],
                    beans: [],
                    distance: 0,
                    scrollOffset: 0,
                    nextWallId: 1,
                    crashReason: null
                };
                rooms.set(code, room);
            }
            const player = addPlayer(room, socket, session.name);
            if (!player) return;
            if (!room.hostId) room.hostId = player.id;
            sendRoomJoined(socket, room, player);
            if (connectedPlayers(room).length >= 2) startGame(room);
            else broadcastState(room);
            return;
        }

        if (message.type === 'joinRoom') {
            if (session.roomCode) {
                sendError(socket, 'Leave your current room before joining another.');
                return;
            }
            const code = typeof message.code === 'string' ? message.code.trim().toUpperCase() : '';
            const room = rooms.get(code);
            if (!room || room.phase !== 'waiting') {
                sendError(socket, 'Room not found or the game has already started.');
                return;
            }
            const player = addPlayer(room, socket, session.name);
            if (!player) return;
            sendRoomJoined(socket, room, player);
            broadcastState(room);
            return;
        }

        const room = session.roomCode && rooms.get(session.roomCode);
        const player = room && room.players.get(session.id);
        if (!room || !player) {
            sendError(socket, 'You are not in a room.');
            return;
        }

        if (message.type === 'leaveRoom') {
            player.socket = null;
            player.connected = false;
            player.voiceReady = false;
            removePlayer(room, player);
            session.roomCode = null;
            session.resumeToken = null;
            send(socket, 'leftRoom', {});
            return;
        }

        if (message.type === 'startGame' || message.type === 'restartGame') {
            if (player.id !== room.hostId) {
                sendError(socket, 'Only the room host can start or restart the game.');
                return;
            }
            if (connectedPlayers(room).length < 2) {
                sendError(socket, 'At least two connected players are needed to start.');
                return;
            }
            if (!startGame(room)) sendError(socket, 'The game cannot be started right now.');
            return;
        }

        if (message.type === 'voiceReady') {
            if (typeof message.enabled !== 'boolean') {
                sendError(socket, 'Invalid voice-chat setting.');
                return;
            }
            player.voiceReady = message.enabled;
            broadcastState(room);
            return;
        }

        if (message.type === 'rtcSignal') {
            if (
                typeof message.to !== 'string' ||
                !message.signal ||
                !['offer', 'answer', 'candidate'].includes(message.signal.type) ||
                JSON.stringify(message.signal).length > 48_000
            ) {
                sendError(socket, 'Invalid voice-chat signal.');
                return;
            }
            const recipient = room.players.get(message.to);
            if (!player.voiceReady || !recipient?.connected || !recipient.voiceReady || recipient.id === player.id) return;
            send(recipient.socket, 'rtcSignal', { from: player.id, signal: message.signal });
            return;
        }

        if (message.type === 'steer') {
            if (room.phase !== 'running' || typeof message.angle !== 'number' || !Number.isFinite(message.angle)) return;
            player.angle = Math.max(0, Math.min(1, message.angle));
            return;
        }

        if (message.type === 'fart') {
            if (room.phase !== 'running') return;
            if (now - player.lastFartAt < 300 || player.gas < 20) {
                send(socket, 'fartRejected', { gas: Math.round(player.gas) });
                return;
            }
            player.lastFartAt = now;
            player.gas -= 20;
            const players = [...room.players.values()].sort((a, b) => a.seat - b.seat);
            const playerIndex = players.findIndex(roomPlayer => roomPlayer.id === player.id);
            const sectorSize = (Math.PI * 2) / players.length;
            const seatAngle = -Math.PI / 2 + playerIndex * sectorSize;
            const angle = seatAngle - sectorSize / 2 + player.angle * sectorSize;
            room.raft.vx += Math.cos(angle + Math.PI) * 2.8;
            room.raft.vy += Math.sin(angle + Math.PI) * 2.8;
            for (const recipient of room.players.values()) {
                if (recipient.id !== player.id && recipient.socket) {
                    send(recipient.socket, 'fart', { playerId: player.id, power: 0.8, angle });
                }
            }
            return;
        }

        sendError(socket, 'Unknown game action.');
    }

    const root = __dirname;
    const httpServer = http.createServer((request, response) => {
        const pathname = new URL(request.url, 'http://localhost').pathname;
        if (request.method === 'GET' && pathname === '/healthz') {
            response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            response.end(JSON.stringify({ status: 'ok', rooms: rooms.size }));
            return;
        }
        const requestedFile = pathname === '/' ? 'index.html' : pathname.slice(1);
        if (request.method !== 'GET' || !['index.html', 'game-config.js'].includes(requestedFile)) {
            response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
            response.end('Not found');
            return;
        }
        fs.readFile(path.join(root, requestedFile), (error, content) => {
            if (error) {
                console.error('Unable to read the game page:', error);
                response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
                response.end('Unable to load the game.');
                return;
            }
            const contentType = requestedFile === 'index.html' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8';
            response.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' });
            response.end(content);
        });
    });

    const webSocketServer = new WebSocketServer({
        server: httpServer,
        path: '/ws',
        maxPayload: MAX_PAYLOAD,
        verifyClient: ({ origin, req }, callback) => {
            if (!origin) return callback(true);
            try {
                const parsedOrigin = new URL(origin);
                callback(
                    parsedOrigin.host === req.headers.host ||
                    allowedOrigins.has(parsedOrigin.origin)
                );
            } catch {
                callback(false, 403, 'Invalid origin');
            }
        }
    });

    webSocketServer.on('connection', socket => {
        socket.session = null;
        socket.rateWindow = Date.now();
        socket.messageCount = 0;
        socket.on('message', data => handleMessage(socket, data));
        socket.on('close', () => {
            const session = socket.session;
            if (!session || !session.roomCode) return;
            const room = rooms.get(session.roomCode);
            const player = room && room.players.get(session.id);
            if (!player || player.socket !== socket) return;
            player.connected = false;
            player.voiceReady = false;
            player.socket = null;
            player.expiresAt = Date.now() + RECONNECT_MS;
            if (room.hostId === player.id) {
                room.hostId = connectedPlayers(room)[0]?.id || player.id;
            }
            broadcastState(room);
        });
        socket.on('error', error => {
            console.error('WebSocket client error:', error.message);
        });
    });

    tickTimer = setInterval(() => {
        for (const room of rooms.values()) {
            stepRoom(room);
            broadcastState(room);
        }
    }, TICK_MS);
    cleanupTimer = setInterval(() => {
        const now = Date.now();
        for (const room of rooms.values()) {
            for (const player of room.players.values()) {
                if (!player.connected && player.expiresAt !== null && player.expiresAt <= now) {
                    removePlayer(room, player);
                }
            }
        }
    }, 1000);
    tickTimer.unref();
    cleanupTimer.unref();

    return {
        httpServer,
        webSocketServer,
        rooms,
        listen(port = options.port ?? PORT, host = options.host ?? '127.0.0.1') {
            return new Promise((resolve, reject) => {
                httpServer.once('error', reject);
                httpServer.listen(port, host, () => {
                    httpServer.removeListener('error', reject);
                    resolve(httpServer.address());
                });
            });
        },
        close() {
            clearInterval(tickTimer);
            clearInterval(cleanupTimer);
            for (const socket of webSocketServer.clients) socket.terminate();
            return new Promise(resolve => {
                webSocketServer.close(() => {
                    if (!httpServer.listening) return resolve();
                    httpServer.close(() => resolve());
                });
            });
        }
    };
}

if (require.main === module) {
    const gameServer = createGameServer();
    gameServer.listen(PORT, process.env.HOST || '0.0.0.0').then(address => {
        console.log(`Fart Together is listening on http://${address.address}:${address.port}`);
    }).catch(error => {
        console.error('Unable to start Fart Together:', error);
        process.exitCode = 1;
    });
}

module.exports = { createGameServer, getRiverCenterAt };
