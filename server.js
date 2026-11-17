import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(ROOT, "data");
const CHATS = path.join(DATA, "chats");
const ROOMS_FILE = path.join(DATA, "rooms.json");
const PORT = Number(process.env.PORT) || 3000;

const HLS_ROOT = path.join(DATA, "hls");
fs.mkdirSync(CHATS, { recursive: true });
fs.mkdirSync(HLS_ROOT, { recursive: true });
const hlsJobs = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startHls(mediaUrl) {
  const id = crypto.createHash("md5").update(mediaUrl).digest("hex").slice(0, 16);
  const dir = path.join(HLS_ROOT, id);
  fs.mkdirSync(dir, { recursive: true });
  const playlist = path.join(dir, "index.m3u8");
  if (!fs.existsSync(playlist) && !hlsJobs.has(id)) {
    const job = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-i", mediaUrl,
      "-c:v", "copy", "-c:a", "copy", "-c:s", "webvtt", "-f", "hls", "-hls_time", "10", "-hls_list_size", "0",
      "-hls_segment_filename", path.join(dir, "seg%d.ts"), playlist,
    ], { stdio: "ignore" });
    hlsJobs.set(id, job);
    job.on("exit", () => hlsJobs.delete(id));
    setTimeout(() => { if (hlsJobs.has(id)) { job.kill(); hlsJobs.delete(id); } }, 30 * 60 * 1000).unref();
  }
  return { id, playlist };
}

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
const memberCount = (room) => [...clients.values()].filter((m) => m.room === room).length;
const announceMembers = (room) => broadcast(room, { t: "members", n: memberCount(room) });

const server = http.createServer(async (req, res) => {
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

  if (url.pathname === "/api/hls") {
    const u = url.searchParams.get("u") || "";
    if (!/^https?:\/\//i.test(u)) { res.writeHead(400, cors); return res.end(JSON.stringify({ error: "bad url" })); }
    try {
      const { id, playlist } = startHls(u);
      const deadline = Date.now() + 20000;
      while (!fs.existsSync(playlist) && Date.now() < deadline) await sleep(300);
      if (!fs.existsSync(playlist)) { res.writeHead(202, cors); return res.end(JSON.stringify({ pending: true })); }
      res.writeHead(200, cors);
      return res.end(JSON.stringify({ url: `/hls/${id}/index.m3u8` }));
    } catch (e) {
      res.writeHead(500, cors);
      return res.end(JSON.stringify({ error: String(e) }));
    }
  }

  let file = url.pathname === "/" ? "/index.html" : url.pathname;
  if (file.startsWith("/hls/")) file = "/data" + file;
  const target = path.join(ROOT, path.normalize(file).replace(/^(\.\.[/\\])+/, ""));
  fs.readFile(target, (err, buf) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    const ext = path.extname(target);
    const type = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json", ".css": "text/css", ".m3u8": "application/vnd.apple.mpegurl", ".ts": "video/mp2t" }[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Access-Control-Allow-Origin": "*" });
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
      send(ws, { t: "joined", code, id: me.id, host: true, members: memberCount(code), history: loadChat(code) });
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
      send(ws, { t: "joined", code, id: me.id, host: isHost, members: memberCount(code), history: loadChat(code) });
      broadcast(code, { t: "hi", n: me.name, id: me.id }, ws);
      announceMembers(code);
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

    if (m.t === "leave") {
      const code = me.room;
      me.room = null; me.secret = ""; me.host = false;
      send(ws, { t: "left" });
      broadcast(code, { t: "bye", id: me.id });
      announceMembers(code);
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
      broadcast(me.room, msg, ws);
      return;
    }

    m.from = me.id;
    broadcast(me.room, m, ws);
  });

  ws.on("close", () => {
    clients.delete(ws);
    if (me.room) { broadcast(me.room, { t: "bye", id: me.id }); announceMembers(me.room); }
  });
});

server.listen(PORT, "0.0.0.0", () => { sweep(); console.log(`Watch Party on http://0.0.0.0:${PORT}`); });
