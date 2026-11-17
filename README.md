# Watch Party

Self-hosted watch-together app with chat. Rooms and chats are stored as JSON on the server.

## Run with Docker

```bash
docker build -t watch-party .
docker run -d --name watch-party -p 3000:3000 -v $(pwd)/data:/app/data watch-party
```

Open `http://SERVER:3000`.

## Run without Docker

```bash
npm install --omit=dev
node server.js
```

## Files

- `index.html` — client app
- `server.js` — HTTP + WebSocket relay server, JSON storage
- `data/rooms.json` — rooms
- `data/chats/<ROOM>.json` — chat history
- `package.json`, `Dockerfile`

## API

- `GET /api/rooms`
- `GET /api/rooms/:code`
- `GET /api/rooms/:code/chats`

Rooms unused for 5 hours are deleted automatically. The room creator can delete a room at any time using the trash icon in the top bar.

## Video formats

Browsers cannot play Matroska (`.mkv`) directly. The server includes ffmpeg and exposes `/api/hls?u=<video-url>`, which remuxes the file to HLS on the fly (video/audio copied, subtitles converted to WebVTT). The client uses this automatically when the browser cannot play MKV, so links play in Chrome and Firefox too. Remuxed files are cached in `data/hls/`.

## Notes (v1.2)

- Chat ownership is now based on a unique per-connection id (`by`) instead of the shared localStorage `cid`. Two tabs on the same browser (same `cid`) no longer render each other's messages as "mine". Reactions still use the stable per-user `cid`, and on rejoin the history uses `cid` so your old messages remain yours.
- Playback failover: if a video hasn't actually started within 60 seconds (autoplay blocked, a stuck buffer, or the partner never signalling ready), the member that can play stops waiting, becomes the leader and publishes its position/rate; the rest of the room follows. If a partner is already playing, the other member keeps following instead of taking over.

## Notes (v1.1)

- Chats are stored per room (`data/chats/<ROOM>.json`); the client clears and reloads history on every (re)join, so rooms never mix.
- The client auto-reconnects (keepalive + backoff) and reloads missed messages, so no manual refresh is needed.
- Playback sync uses a server-clock offset and position+timestamp state, with continuous drift correction. Any member can control playback.
- MKV/AVI/TS links are always remuxed to HLS (H.264 + AAC) by the server so Chrome, Android and iOS can play them.
- If a browser blocks autoplay (iOS/Android), a big ▶ button appears; one tap starts playback at the synced position.
