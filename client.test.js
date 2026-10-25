'use strict';

const assert = require('node:assert/strict');
const { JSDOM, VirtualConsole } = require('jsdom');
const test = require('node:test');
const { createGameServer } = require('./server');

const canvasContext = new Proxy({}, {
    get(target, property) {
        if (property in target) return target[property];
        return () => {};
    },
    set(target, property, value) {
        target[property] = value;
        return true;
    }
});

async function startServer() {
    const gameServer = createGameServer({ host: '127.0.0.1', port: 0 });
    const address = await gameServer.listen();
    return { gameServer, pageUrl: `http://127.0.0.1:${address.port}/` };
}

async function openGame(pageUrl, enableVoiceTest = false) {
    const virtualConsole = new VirtualConsole();
    const errors = [];
    const voiceState = { offers: 0, answers: 0, tracks: [] };
    virtualConsole.on('jsdomError', error => errors.push(error));
    const dom = await JSDOM.fromURL(pageUrl, {
        runScripts: 'dangerously',
        resources: 'usable',
        pretendToBeVisual: true,
        virtualConsole,
        beforeParse(window) {
            window.WebSocket = require('ws');
            window.requestAnimationFrame = () => 1;
            window.cancelAnimationFrame = () => {};
            window.HTMLCanvasElement.prototype.getContext = () => canvasContext;
            if (enableVoiceTest) {
                class FakeRTCPeerConnection {
                    constructor() {
                        this.signalingState = 'stable';
                        this.connectionState = 'new';
                        this.localDescription = null;
                        this.remoteDescription = null;
                    }
                    addTrack() {}
                    createOffer() {
                        voiceState.offers += 1;
                        return Promise.resolve({ type: 'offer', sdp: 'fake-offer' });
                    }
                    createAnswer() {
                        voiceState.answers += 1;
                        return Promise.resolve({ type: 'answer', sdp: 'fake-answer' });
                    }
                    setLocalDescription(description) {
                        this.localDescription = description;
                        this.signalingState = description.type === 'offer' ? 'have-local-offer' : 'stable';
                        return Promise.resolve();
                    }
                    setRemoteDescription(description) {
                        this.remoteDescription = description;
                        this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable';
                        return Promise.resolve();
                    }
                    addIceCandidate() { return Promise.resolve(); }
                    close() { this.connectionState = 'closed'; }
                }
                window.RTCPeerConnection = FakeRTCPeerConnection;
                window.HTMLMediaElement.prototype.play = () => Promise.resolve();
                Object.defineProperty(window.navigator, 'mediaDevices', {
                    configurable: true,
                    value: {
                        getUserMedia: async () => {
                            const track = { enabled: true, stopped: false, stop() { this.stopped = true; } };
                            voiceState.tracks.push(track);
                            return { getTracks: () => [track], getAudioTracks: () => [track] };
                        }
                    }
                });
            }
            window.HTMLElement.prototype.getBoundingClientRect = function() {
                if (this.id === 'pieCanvas') return { left: 0, top: 0, width: 130, height: 130 };
                if (this.classList?.contains('minimap-box')) return { left: 0, top: 0, width: 90, height: 90 };
                return { left: 0, top: 0, width: 440, height: 920 };
            };
            Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', {
                get() { return this.classList?.contains('minimap-box') ? 90 : 440; }
            });
        }
    });
    return { dom, errors, voiceState };
}

async function waitFor(predicate, description, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`Timed out waiting for ${description}.`);
}

test('browser lobby creates and joins a room, starts a shared run, and spends gas on fart', async () => {
    const { gameServer, pageUrl } = await startServer();
    let host;
    let guest;
    let invitee;
    try {
        [host, guest] = await Promise.all([openGame(pageUrl), openGame(pageUrl)]);
        const hostDoc = host.dom.window.document;
        const guestDoc = guest.dom.window.document;
        await waitFor(() => hostDoc.getElementById('connectionBadge').textContent === 'Connected', 'host connection');
        await waitFor(() => guestDoc.getElementById('connectionBadge').textContent === 'Connected', 'guest connection');

        hostDoc.getElementById('playerNameInput').value = 'River Host';
        hostDoc.getElementById('createRoomBtn').click();
        await waitFor(() => hostDoc.getElementById('roomCodeDisplay').textContent.length === 5, 'room creation');
        const roomCode = hostDoc.getElementById('roomCodeDisplay').textContent;
        assert.equal(hostDoc.getElementById('startGameBtn').disabled, true);
        assert.equal(hostDoc.getElementById('voiceToggleBtn').disabled, false);
        assert.equal(hostDoc.getElementById('micMuteBtn').disabled, true);

        invitee = await openGame(`${pageUrl}?room=${roomCode}`);
        await waitFor(() => hostDoc.getElementById('playerRows').children.length === 2, 'invite-link join');

        guestDoc.getElementById('playerNameInput').value = 'River Guest';
        guestDoc.getElementById('roomCodeInput').value = roomCode;
        guestDoc.getElementById('joinRoomBtn').click();
        await waitFor(() => hostDoc.getElementById('playerRows').children.length === 3, 'shared player list');
        await waitFor(() => guestDoc.getElementById('playerRows').children.length === 3, 'guest player list');
        await waitFor(() => invitee.dom.window.document.getElementById('playerRows').children.length === 3, 'invitee player list');

        hostDoc.getElementById('startGameBtn').click();
        await waitFor(() => hostDoc.getElementById('lobbyModal').classList.contains('hidden'), 'host game start');
        await waitFor(() => guestDoc.getElementById('lobbyModal').classList.contains('hidden'), 'guest game start');
        await waitFor(() => Number.parseInt(hostDoc.getElementById('scoreText').innerText, 10) > 0, 'shared distance update');
        assert.equal(hostDoc.getElementById('scoreText').innerText, guestDoc.getElementById('scoreText').innerText);

        hostDoc.getElementById('btnFart').click();
        await waitFor(() => hostDoc.getElementById('p1GasText').textContent !== '100%', 'authoritative gas update');
        assert.equal(hostDoc.getElementById('scoreText').innerText.endsWith('m'), true);
        assert.deepEqual(host.errors, []);
        assert.deepEqual(guest.errors, []);
        assert.deepEqual(invitee.errors, []);

        gameServer.rooms.get(roomCode).raft.x = 200;
        await waitFor(() => !hostDoc.getElementById('gameOverModal').classList.contains('hidden'), 'shared crash screen');
        await waitFor(() => !guestDoc.getElementById('gameOverModal').classList.contains('hidden'), 'guest crash screen');
        hostDoc.getElementById('restartBtn').click();
        await waitFor(() => hostDoc.getElementById('gameOverModal').classList.contains('hidden'), 'team rematch');
    } finally {
        host?.dom.window.close();
        guest?.dom.window.close();
        invitee?.dom.window.close();
        await gameServer.close();
    }
});

test('optional room voice connects only after opt-in and exposes mute/deafen controls', async () => {
    const { gameServer, pageUrl } = await startServer();
    let host;
    let guest;
    try {
        [host, guest] = await Promise.all([
            openGame(pageUrl, true),
            openGame(pageUrl, true)
        ]);
        const hostDoc = host.dom.window.document;
        const guestDoc = guest.dom.window.document;
        await waitFor(() => hostDoc.getElementById('connectionBadge').textContent === 'Connected', 'host connection');
        await waitFor(() => guestDoc.getElementById('connectionBadge').textContent === 'Connected', 'guest connection');

        hostDoc.getElementById('createRoomBtn').click();
        await waitFor(() => hostDoc.getElementById('roomCodeDisplay').textContent.length === 5, 'voice room creation');
        guestDoc.getElementById('roomCodeInput').value = hostDoc.getElementById('roomCodeDisplay').textContent;
        guestDoc.getElementById('joinRoomBtn').click();
        await waitFor(() => guestDoc.getElementById('playerRows').children.length === 2, 'voice room join');

        hostDoc.getElementById('voiceToggleBtn').click();
        guestDoc.getElementById('voiceToggleBtn').click();
        await waitFor(() => host.voiceState.offers + guest.voiceState.offers > 0, 'WebRTC offer');
        await waitFor(() => host.voiceState.answers + guest.voiceState.answers > 0, 'WebRTC answer');
        assert.equal(hostDoc.getElementById('voiceToggleBtn').textContent, 'LEAVE VOICE');
        assert.equal(guestDoc.getElementById('micMuteBtn').textContent, 'MUTE MIC');

        guestDoc.getElementById('micMuteBtn').click();
        assert.equal(guest.voiceState.tracks[0].enabled, false);
        assert.equal(guestDoc.getElementById('micMuteBtn').textContent, 'UNMUTE MIC');
        guestDoc.getElementById('deafenToggleBtn').click();
        assert.equal(guestDoc.getElementById('deafenToggleBtn').textContent, 'UNDEAFEN');

        hostDoc.getElementById('voiceToggleBtn').click();
        await waitFor(() => hostDoc.getElementById('voiceToggleBtn').textContent === 'JOIN VOICE', 'leave voice');
        assert.equal(host.voiceState.tracks[0].stopped, true);

        guestDoc.getElementById('leaveRoomBtn').click();
        await waitFor(() => guestDoc.getElementById('voiceToggleBtn').disabled, 'room leave');
        assert.equal(guest.voiceState.tracks[0].stopped, true);
    } finally {
        host?.dom.window.close();
        guest?.dom.window.close();
        await gameServer.close();
    }
});
