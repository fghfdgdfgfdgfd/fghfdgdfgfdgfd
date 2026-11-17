import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(ROOT, "data");
const CHATS = path.join(DATA, "chats");
const ROOMS_FILE = path.join(DATA, "rooms.json");
const PORT = Number(process.env.PORT) || 3000;

fs.mkdirSync(CHATS, { recursive: true });

const readJson = (f, fallback) => {
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fallback; }
};
const writeJson = (f, value) => fs.writeFileSync(f, JSON.stringify(value, null, 2));

let rooms = readJson(ROOMS_FILE, {});
const chatFile = (code) => path.join(CHATS, `${code}.json`);
const loadChat = (code) => readJson(chatFile(code), []);
const saveChat = (code, list) => writeJson(chatFile(code), list.slice(-500));
const codeOk = (c) => /^[A-Z0-9]{4,10}$/.test(c || "");
const newCode = () => {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let c;
  do { c = Array.from({ length: 6 }, () => abc[Math.random() * abc.length | 0]).join(""); }
  while (rooms[c]);
  return c;
};
const uid = () => Math.random().toString(36).slice(2, 9);
const TTL_MS = 5 * 60 * 60 * 1000;

function touch(code) {
  const r = rooms[code];
  if (!r) return;
  r.lastUsed = Date.now();
  writeJson(ROOMS_FILE, rooms);
}

function deleteRoom(code) {
  if (!rooms[code]) return;
  delete rooms[code];
  writeJson(ROOMS_FILE, rooms);
  try { fs.unlinkSync(chatFile(code)); } catch {}
  for (const [ws, me] of clients) {
    if (me.room === code) { me.room = null; send(ws, { t: "deleted", code }); }
  }
  console.log("room deleted", code);
}

function sweep() {
  const now = Date.now();
  for (const [code, r] of Object.entries(rooms)) {
    const last = r.lastUsed || r.created || now;
    if (now - last > TTL_MS) deleteRoom(code);
  }
}
setInterval(sweep, 5 * 60 * 1000).unref();

const send = (ws, obj) => {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
};
const broadcast = (room, obj, except) => {
  for (const [ws, me] of clients) {
    if (ws !== except && me.room === room) send(ws, obj);
  }
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
  };
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }

  if (url.pathname === "/api/rooms") {
    res.writeHead(200, cors);
    return res.end(JSON.stringify(Object.values(rooms).map((r) => ({
      code: r.code, created: r.created, messages: loadChat(r.code).length,
    }))));
  }
  const api = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9]+)(?:\/(chats))?$/);
  if (api) {
    const code = api[1].toUpperCase();
    res.writeHead(200, cors);
    if (!codeOk(code) || !rooms[code]) return res.end(JSON.stringify({ error: "not found" }));
    if (api[2] === "chats") return res.end(JSON.stringify(loadChat(code)));
    return res.end(JSON.stringify({ ...rooms[code], members: [...clients.values()].filter((m) => m.room === code).length }));
  }

  let file = url.pathname === "/" ? "/index.html" : url.pathname;
  const target = path.join(ROOT, path.normalize(file).replace(/^(\.\.[/\\])+/, ""));
  fs.readFile(target, (err, buf) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    const ext = path.extname(target);
    const type = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json", ".css": "text/css" }[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    res.end(buf);
  });
});

const wss = new WebSocketServer({ server, path: "/ws" });
const clients = new Map();

wss.on("connection", (ws) => {
  const me = { id: uid(), room: null, name: "Guest" };
  clients.set(ws, me);

  ws.on("message", (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }

    if (m.t === "create") {
      const code = newCode();
      rooms[code] = { code, created: Date.now(), lastUsed: Date.now(), host: me.id, secret: String(m.secret || "") };
      writeJson(ROOMS_FILE, rooms);
      me.room = code; me.name = String(m.n || "Guest").slice(0, 20);
      me.secret = String(m.secret || ""); me.host = true;
      send(ws, { t: "joined", code, id: me.id, host: true, history: loadChat(code) });
      return;
    }

    if (m.t === "join") {
      const code = String(m.room || "").trim().toUpperCase();
      if (!codeOk(code) || !rooms[code]) { send(ws, { t: "err", msg: "Room not found" }); return; }
      me.room = code; me.name = String(m.n || "Guest").slice(0, 20);
      me.secret = String(m.secret || "");
      const isHost = !!me.secret && me.secret === rooms[code].secret;
      me.host = isHost;
      touch(code);
      send(ws, { t: "joined", code, id: me.id, host: isHost, history: loadChat(code) });
      broadcast(code, { t: "hi", n: me.name, id: me.id }, ws);
      return;
    }

    if (!me.room) return;
    touch(me.room);

    if (m.t === "delete") {
      const secret = String(m.secret || me.secret || "");
      if (!secret || !rooms[me.room] || rooms[me.room].secret !== secret) { send(ws, { t: "err", msg: "Only host can delete" }); return; }
      deleteRoom(me.room);
      return;
    }

    if (m.t === "chat") {
      const msg = {
        t: "chat", id: String(m.id || uid()).slice(0, 20), n: me.name,
        x: String(m.x || "").slice(0, 2000), q: String(m.q || "").slice(0, 120),
        c: m.c, ts: Date.now(),
      };
      const list = loadChat(me.room);
      list.push(msg);
      saveChat(me.room, list);
      broadcast(me.room, msg);
      return;
    }

    m.from = me.id;
    broadcast(me.room, m, ws);
  });

  ws.on("close", () => {
    clients.delete(ws);
    if (me.room) broadcast(me.room, { t: "bye", id: me.id });
  });
});

server.listen(PORT, "0.0.0.0", () => { sweep(); console.log(`Watch Party on http://0.0.0.0:${PORT}`); });
