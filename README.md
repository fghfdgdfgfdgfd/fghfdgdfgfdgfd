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
