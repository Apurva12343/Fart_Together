'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const test = require('node:test');
const { WebSocket } = require('ws');
const { createGameServer } = require('./server');

async function startServer(options = {}) {
    const gameServer = createGameServer({ host: '127.0.0.1', port: 0, ...options });
    const address = await gameServer.listen();
    return { gameServer, url: `ws://127.0.0.1:${address.port}/ws`, pageUrl: `http://127.0.0.1:${address.port}/` };
}

function waitForMessage(socket, predicate, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            socket.removeListener('message', onMessage);
            reject(new Error('Timed out waiting for a game-server message.'));
        }, timeoutMs);
        function onMessage(raw) {
            const message = JSON.parse(raw.toString());
            if (!predicate(message)) return;
            clearTimeout(timeout);
            socket.removeListener('message', onMessage);
            resolve(message);
        }
        socket.on('message', onMessage);
    });
}

async function connect(url, name, resumeToken, origin) {
    const socket = new WebSocket(url, origin ? { origin } : {});
    await once(socket, 'open');
    socket.send(JSON.stringify({ type: 'hello', name, resumeToken }));
    return { socket, welcome: await waitForMessage(socket, message => message.type === 'welcome' || message.type === 'roomJoined') };
}

test('serves index.html and game config and permits only configured cross-origin clients', async () => {
    const { gameServer, url, pageUrl } = await startServer({
        allowedOrigins: ['https://fart-together.netlify.app']
    });
    try {
        const [page, config] = await Promise.all([
            fetch(pageUrl),
            fetch(new URL('/game-config.js', pageUrl))
        ]);
        assert.equal(page.status, 200);
        assert.match(await page.text(), /FART TOGETHER/);
        assert.equal(config.status, 200);
        assert.match(config.headers.get('content-type'), /javascript/);

        const deniedSocket = new WebSocket(url, { origin: 'https://attacker.example' });
        await once(deniedSocket, 'error');

        const allowed = await connect(url, 'NetlifyPlayer', undefined, 'https://fart-together.netlify.app');
        assert.equal(allowed.welcome.type, 'welcome');
        allowed.socket.close();
    } finally {
        await gameServer.close();
    }
});

test('room codes join a shared authoritative game and only the host can start', async () => {
    const { gameServer, url } = await startServer();
    try {
        const host = await connect(url, 'HostPlayer');
        const guest = await connect(url, 'GuestPlayer');

        const createdRoom = waitForMessage(host.socket, message => message.type === 'roomJoined');
        host.socket.send(JSON.stringify({ type: 'createRoom' }));
        const room = await createdRoom;
        assert.match(room.state.code, /^[A-HJ-NP-Z2-9]{5}$/);
        assert.equal(room.state.players.length, 1);
        const onePlayerStart = waitForMessage(host.socket, message => message.type === 'error');
        host.socket.send(JSON.stringify({ type: 'startGame' }));
        assert.match((await onePlayerStart).message, /two connected players/i);

        const joinedRoom = waitForMessage(guest.socket, message => message.type === 'roomJoined');
        guest.socket.send(JSON.stringify({ type: 'joinRoom', code: room.state.code }));
        const joined = await joinedRoom;
        assert.equal(joined.state.players.length, 2);
        assert.equal(joined.state.players[0].sectorSize, Math.PI);
        assert.equal(joined.state.players[1].sectorSize, Math.PI);
        assert.notEqual(joined.state.players[0].seatAngle, joined.state.players[1].seatAngle);

        const deniedStart = waitForMessage(guest.socket, message => message.type === 'error');
        guest.socket.send(JSON.stringify({ type: 'startGame' }));
        assert.match((await deniedStart).message, /host/i);

        const started = waitForMessage(host.socket, message => message.type === 'gameStarted');
        host.socket.send(JSON.stringify({ type: 'startGame' }));
        await started;

        const voiceReady = waitForMessage(host.socket, message =>
            message.type === 'state' && message.state.players.every(player => player.voiceReady)
        );
        host.socket.send(JSON.stringify({ type: 'voiceReady', enabled: true }));
        guest.socket.send(JSON.stringify({ type: 'voiceReady', enabled: true }));
        await voiceReady;
        const relayedSignal = waitForMessage(guest.socket, message => message.type === 'rtcSignal');
        host.socket.send(JSON.stringify({
            type: 'rtcSignal',
            to: joined.playerId,
            signal: { type: 'offer', description: { type: 'offer', sdp: 'test-sdp' } }
        }));
        assert.equal((await relayedSignal).from, room.playerId);

        const fartState = waitForMessage(host.socket, message =>
            message.type === 'state' &&
            message.state.phase === 'running' &&
            message.state.players.find(player => player.id === joined.playerId)?.gas < 90
        );
        guest.socket.send(JSON.stringify({ type: 'fart' }));
        const state = await fartState;
        assert.equal(state.state.players.length, 2);
        assert.ok(state.state.walls.length > 0);
        assert.ok(state.state.score > 0);

        const crashed = waitForMessage(host.socket, message => message.type === 'crash');
        gameServer.rooms.get(room.state.code).raft.x = 200;
        assert.match((await crashed).reason, /riverbank/i);
        const finished = waitForMessage(host.socket, message => message.type === 'state' && message.state.phase === 'finished');
        await finished;

        const restarted = waitForMessage(host.socket, message => message.type === 'state' && message.state.phase === 'running' && message.state.score === 0);
        host.socket.send(JSON.stringify({ type: 'restartGame' }));
        await restarted;
    } finally {
        await gameServer.close();
    }
});

test('quick match starts when a second player joins and guest reconnect restores their seat', async () => {
    const { gameServer, url } = await startServer();
    try {
        const first = await connect(url, 'FirstRider');
        const firstRoomPromise = waitForMessage(first.socket, message => message.type === 'roomJoined');
        first.socket.send(JSON.stringify({ type: 'quickMatch' }));
        const firstRoom = await firstRoomPromise;

        const second = await connect(url, 'SecondRider');
        const secondRoomPromise = waitForMessage(second.socket, message => message.type === 'roomJoined');
        second.socket.send(JSON.stringify({ type: 'quickMatch' }));
        const secondRoom = await secondRoomPromise;
        assert.equal(secondRoom.state.code, firstRoom.state.code);

        const started = waitForMessage(first.socket, message => message.type === 'gameStarted');
        await started;
        const secondPlayerId = secondRoom.playerId;
        second.socket.close();
        await once(second.socket, 'close');

        const reconnectedSocket = new WebSocket(url);
        await once(reconnectedSocket, 'open');
        const resumedRoomPromise = waitForMessage(reconnectedSocket, message => message.type === 'roomJoined');
        reconnectedSocket.send(JSON.stringify({
            type: 'hello',
            name: 'SecondRider',
            resumeToken: secondRoom.resumeToken
        }));
        const resumed = await resumedRoomPromise;
        assert.equal(resumed.playerId, secondPlayerId);
        assert.equal(resumed.resumed, true);
        assert.equal(resumed.state.phase, 'running');
        reconnectedSocket.close();
    } finally {
        await gameServer.close();
    }
});

test('raft sectors divide evenly as rooms grow from two to four players', async () => {
    const { gameServer, url } = await startServer();
    const clients = [];
    try {
        clients.push(await connect(url, 'SeatOne'));
        const created = waitForMessage(clients[0].socket, message => message.type === 'roomJoined');
        clients[0].socket.send(JSON.stringify({ type: 'createRoom' }));
        const room = await created;
        const code = room.state.code;

        for (let playerCount = 2; playerCount <= 4; playerCount += 1) {
            const client = await connect(url, `Seat${playerCount}`);
            clients.push(client);
            const joined = waitForMessage(client.socket, message => message.type === 'roomJoined');
            client.socket.send(JSON.stringify({ type: 'joinRoom', code }));
            const state = (await joined).state;
            const sectorSize = (Math.PI * 2) / playerCount;
            assert.equal(state.players.length, playerCount);
            for (let index = 0; index < playerCount; index += 1) {
                assert.ok(Math.abs(state.players[index].sectorSize - sectorSize) < 1e-10);
                assert.ok(Math.abs(state.players[index].seatAngle - (-Math.PI / 2 + index * sectorSize)) < 1e-10);
            }
        }
    } finally {
        for (const client of clients) client.socket.close();
        await gameServer.close();
    }
});

test('invalid player names are rejected before room actions are available', async () => {
    const { gameServer, url } = await startServer();
    try {
        const socket = new WebSocket(url);
        await once(socket, 'open');
        const error = waitForMessage(socket, message => message.type === 'error');
        socket.send(JSON.stringify({ type: 'hello', name: '<x>' }));
        assert.match((await error).message, /name/i);
        socket.close();
    } finally {
        await gameServer.close();
    }
});
