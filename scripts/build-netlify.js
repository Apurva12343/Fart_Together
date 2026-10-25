'use strict';

const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const outputDirectory = path.join(projectRoot, 'dist');
const configuredServerUrl = (process.env.GAME_SERVER_URL || '').trim();

function getServerOrigin(value) {
    if (!value) return '';
    let serverUrl;
    try {
        serverUrl = new URL(value);
    } catch {
        throw new Error('GAME_SERVER_URL must be a valid https:// or wss:// server origin.');
    }
    if (!['https:', 'wss:'].includes(serverUrl.protocol) || serverUrl.username || serverUrl.password) {
        throw new Error('GAME_SERVER_URL must use https:// or wss:// without credentials.');
    }
    if (serverUrl.pathname !== '/' && serverUrl.pathname !== '/ws') {
        throw new Error('GAME_SERVER_URL must be the game server origin, without a path.');
    }
    if (serverUrl.search || serverUrl.hash) {
        throw new Error('GAME_SERVER_URL must not include a query string or fragment.');
    }
    return serverUrl.origin;
}

const serverOrigin = getServerOrigin(configuredServerUrl);
fs.mkdirSync(outputDirectory, { recursive: true });
fs.copyFileSync(path.join(projectRoot, 'index.html'), path.join(outputDirectory, 'index.html'));
fs.writeFileSync(
    path.join(outputDirectory, 'game-config.js'),
    `window.GAME_SERVER_URL = ${JSON.stringify(serverOrigin)};\n`,
    'utf8'
);
console.log(serverOrigin
    ? `Prepared Netlify site for game server ${serverOrigin}`
    : 'Prepared Netlify site. Set GAME_SERVER_URL to enable online multiplayer.');
