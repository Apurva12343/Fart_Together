# Fart Together

A cooperative browser game: join the same raft, steer through river gates, and time fart boosts together.

## Deploy to Netlify

Netlify hosts the static game page; it does **not** run this game's persistent WebSocket multiplayer server. Deploy the page to Netlify and the game server to a Node.js host such as Render.

1. Push this project to a GitHub repository.
2. In Netlify, import the repository as a new site. `netlify.toml` configures the build and publishes the generated `dist` folder. The source page is already named `index.html`.
3. Deploy the site once and copy its Netlify URL, for example `https://your-game.netlify.app`.
4. In Render, create a Blueprint from the same repository using `render.yaml`. Set `ALLOWED_ORIGINS` to the exact Netlify site origin, including `https://` and no path. Deploy the service and copy its public URL, for example `https://fart-together-server.onrender.com`.
5. In Netlify, open **Site configuration → Environment variables** and add `GAME_SERVER_URL` with the Render origin (for example `https://fart-together-server.onrender.com`).
6. Redeploy the Netlify site so its build writes the game-server URL into `game-config.js`.
7. Open the Netlify URL in two or more tabs/devices. Create a room, share the code/link, and have the host start once at least two players are connected.

If the Render service's access policy was set before you knew the Netlify URL, update `ALLOWED_ORIGINS` in Render after step 3 and redeploy/restart the service. The allowed origin and `GAME_SERVER_URL` must match the real site/server URLs exactly. Keep the backend URL on `https://`; the browser automatically uses secure `wss://` for multiplayer.

For a manual Netlify drag-and-drop deploy, do not upload just `index.html`: the game also needs `game-config.js`. After deploying the backend and setting `ALLOWED_ORIGINS`, build the site locally with your Render URL:

```powershell
$env:GAME_SERVER_URL = "https://your-server.onrender.com"
npm run build:netlify
```

Upload the generated `dist` folder to Netlify. The generated server URL is public site configuration, not a secret.

Voice chat requires HTTPS and microphone permission. The browser asks permission only when the player chooses **JOIN VOICE**.

## Run locally

1. Install Node.js 20 or newer.
2. From this folder, run `npm install`.
3. Run `npm start`.
4. Open `http://localhost:3000` in two or more browser tabs/devices. Create a room, share its code or invite link, and join from the other clients.
5. A room host can start once at least two players are connected. Quick Match starts automatically when a second player joins.

Run the server checks with `npm test`. To check the Netlify build locally, run `npm run build:netlify`; it creates the deployable static site in `dist`.

## Current online build

- Supports up to four players on one shared raft.
- Requires at least two connected players to start. Each player receives a fixed seat and their own equal raft sector: 180° with two players, 120° with three, and 90° with four. Steering/fart aim stays inside that player's sector.
- The server owns raft physics, gas, obstacle generation, pickups, collisions, and team distance; clients send steering/fart inputs.
- Room codes, quick matchmaking, shareable room links, host restart, and a 30-second reconnect window are supported.
- Optional room voice is off until a player joins it and grants microphone permission. Mic mute and deafen controls are available. Voice uses peer-to-peer WebRTC; each player should only join voice with people they trust.
- Display names are stored in the browser; reconnect tokens are kept in per-tab session storage so invite links can open separately. Reconnect tokens grant access to their room, so do not share them.
- Room state and guest identities are in memory. Restarting the server clears rooms; durable accounts, friends, moderation, and progression are not implemented yet.
- This build is 2D. The 3D upgrade is a future milestone.

## Hosting notes

The Node server needs a host that supports long-lived WebSocket connections; Netlify's static hosting alone cannot provide the game server. `render.yaml` provides a Render starting point. The backend allowlists the Netlify website's exact origin using `ALLOWED_ORIGINS`.

Voice uses a public STUN server for peer connectivity and may not work behind restrictive NAT/firewalls; production deployment should provide a TURN relay. The current server is an in-memory prototype: use a shared persistent datastore and an account/authentication design before running multiple server instances or shipping persistent social features.
