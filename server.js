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

const run = (cmd, args, ms = 15000) => new Promise((resolve) => {
  let out = "";
  const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
  const t = setTimeout(() => p.kill(), ms);
  p.stdout.on("data", (d) => (out += d));
  p.on("exit", () => { clearTimeout(t); resolve(out.trim()); });
  p.on("error", () => { clearTimeout(t); resolve(""); });
});

// Remux/transcode to HLS that every browser (Chrome, Safari/iOS, Android) can play:
// H.264 video (copied when already H.264 8-bit, otherwise re-encoded), AAC stereo audio.
async function startHls(mediaUrl) {
  const id = crypto.createHash("md5").update(mediaUrl).digest("hex").slice(0, 16);
  const dir = path.join(HLS_ROOT, id);
  fs.mkdirSync(dir, { recursive: true });
  const playlist = path.join(dir, "index.m3u8");
  if (!fs.existsSync(playlist) && !hlsJobs.has(id)) {
    hlsJobs.set(id, null);
    const info = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,pix_fmt", "-of", "csv=p=0", mediaUrl]);
    const vcopy = /^h264,yuv420p/.test(info);
    const job = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-i", mediaUrl, "-map", "0:v:0", "-map", "0:a:0?", "-sn",
      ...(vcopy ? ["-c:v", "copy"] : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p"]),
      "-c:a", "aac", "-b:a", "160k", "-ac", "2",
      "-f", "hls", "-hls_time", "6", "-hls_list_size", "0", "-hls_playlist_type", "event", "-hls_flags", "independent_segments",
      "-hls_segment_filename", path.join(dir, "seg%d.ts"), playlist,
    ], { stdio: "ignore" });
    hlsJobs.set(id, job);
    job.on("exit", () => hlsJobs.delete(id));
    setTimeout(() => { if (hlsJobs.get(id) === job) { job.kill(); hlsJobs.delete(id); } }, 3 * 60 * 60 * 1000).unref();
    // first subtitle track -> WebVTT (published only when complete)
    const tmp = path.join(dir, "sub.tmp"), sub = path.join(dir, "sub.vtt");
    const sp = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", mediaUrl, "-map", "0:s:0", "-c:s", "webvtt", "-f", "webvtt", tmp], { stdio: "ignore" });
    sp.on("exit", (c) => { if (c === 0 && fs.existsSync(tmp)) try { fs.renameSync(tmp, sub); } catch {} });
    sp.on("error", () => {});
  }
  return { id, playlist };
}

const readJson = (f, fallback) => {
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fallback; }
};
const writeJson = (f, value) => fs.writeFileSync(f, JSON.stringify(value, null, 2));

let rooms = readJson(ROOMS_FILE, {});
const chatFile = (code) => path.join(CHATS, `${code}.json`);
const chatCache = new Map(), chatTimers = new Map();
const loadChat = (code) => { if (!chatCache.has(code)) chatCache.set(code, readJson(chatFile(code), [])); return chatCache.get(code); };
const saveChat = (code, list) => {
  chatCache.set(code, list.slice(-500));
  clearTimeout(chatTimers.get(code));
  chatTimers.set(code, setTimeout(() => writeJson(chatFile(code), chatCache.get(code) || []), 1500));
};
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
  if (Date.now() - lastSave > 30000) { lastSave = Date.now(); writeJson(ROOMS_FILE, rooms); }
}
let lastSave = 0;

function deleteRoom(code) {
  if (!rooms[code]) return;
  delete rooms[code];
  writeJson(ROOMS_FILE, rooms);
  clearTimeout(chatTimers.get(code)); chatTimers.delete(code); chatCache.delete(code);
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
    return res.end(JSON.stringify({ code, created: rooms[code].created, members: [...clients.values()].filter((m) => m.room === code).length }));
  }

  if (url.pathname === "/api/hls") {
    const u = url.searchParams.get("u") || "";
    if (!/^https?:\/\//i.test(u)) { res.writeHead(400, cors); return res.end(JSON.stringify({ error: "bad url" })); }
    try {
      const { id, playlist } = await startHls(u);
      const deadline = Date.now() + 20000;
      while (!fs.existsSync(playlist) && Date.now() < deadline) await sleep(300);
      if (!fs.existsSync(playlist)) { res.writeHead(202, cors); return res.end(JSON.stringify({ pending: true })); }
      res.writeHead(200, cors);
      return res.end(JSON.stringify({ url: `/hls/${id}/index.m3u8`, sub: `/hls/${id}/sub.vtt` }));
    } catch (e) {
      res.writeHead(500, cors);
      return res.end(JSON.stringify({ error: String(e) }));
    }
  }

  let target;
  if (url.pathname === "/" || url.pathname === "/index.html") target = path.join(ROOT, "index.html");
  else if (/^\/hls\/[a-f0-9]{16}\/[\w.-]+$/.test(url.pathname)) target = path.join(DATA, url.pathname);
  else { res.writeHead(404); return res.end("Not found"); }
  fs.readFile(target, (err, buf) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    const ext = path.extname(target);
    const type = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json", ".css": "text/css", ".m3u8": "application/vnd.apple.mpegurl", ".ts": "video/mp2t", ".vtt": "text/vtt; charset=utf-8" }[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Access-Control-Allow-Origin": "*", "Cache-Control": ext === ".m3u8" || ext === ".html" ? "no-store" : "public, max-age=3600" });
    res.end(buf);
  });
});

const RELAY = new Set(["src", "st", "rdy", "req", "fmeta", "fgo", "fno", "fstop", "fc", "fdone"]);
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 4 << 20 });
setInterval(() => { for (const w of wss.clients) { if (w.isAlive === false) { w.terminate(); continue; } w.isAlive = false; try { w.ping(); } catch {} } }, 25000).unref();
const clients = new Map();

wss.on("connection", (ws) => {
  const me = { id: uid(), cid: "", room: null, name: "Guest" };
  clients.set(ws, me);
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  const leaveCur = () => {
    if (!me.room) return;
    const c = me.room; me.room = null; me.host = false;
    broadcast(c, { t: "bye", id: me.id }); announceMembers(c);
  };

  ws.on("message", (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }

    if (m.t === "cp") { send(ws, { t: "cp", c: m.c, s: Date.now() }); return; }

    if (m.t === "create") {
      leaveCur();
      me.cid = String(m.cid || me.id).slice(0, 20);
      const code = newCode();
      rooms[code] = { code, created: Date.now(), lastUsed: Date.now(), host: me.id, secret: String(m.secret || "") };
      writeJson(ROOMS_FILE, rooms);
      me.room = code; me.name = String(m.n || "Guest").slice(0, 20);
      me.secret = String(m.secret || ""); me.host = true;
      send(ws, { t: "joined", code, id: me.id, host: true, members: memberCount(code), history: loadChat(code), src: "" });
      return;
    }

    if (m.t === "join") {
      const code = String(m.room || "").trim().toUpperCase();
      if (!codeOk(code) || !rooms[code]) { send(ws, { t: "err", msg: "Room not found" }); return; }
      leaveCur();
      me.cid = String(m.cid || me.id).slice(0, 20);
      me.room = code; me.name = String(m.n || "Guest").slice(0, 20);
      me.secret = String(m.secret || "");
      const isHost = !!me.secret && me.secret === rooms[code].secret;
      me.host = isHost;
      touch(code);
      send(ws, { t: "joined", code, id: me.id, host: isHost, members: memberCount(code), history: loadChat(code), src: rooms[code].src || "" });
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
      const now = Date.now();
      me.mt = (me.mt || []).filter((x) => now - x < 3000);
      if (me.mt.length >= 8) return;
      me.mt.push(now);
      const x = String(m.x || "").slice(0, 2000);
      if (!x.trim()) return;
      const list = loadChat(me.room);
      const id = String(m.id || uid()).slice(0, 20);
      if (list.some((y) => y.id === id)) return;
      const msg = {
        t: "chat", id, n: me.name, u: me.cid, x, q: String(m.q || "").slice(0, 120),
        c: /^hsl\([\d\s%]+\)$/.test(m.c || "") ? m.c : "", ts: now,
      };
      list.push(msg);
      saveChat(me.room, list);
      broadcast(me.room, msg, ws);
      return;
    }

    if (m.t === "re") {
      const list = loadChat(me.room);
      const msg = list.find((y) => y.id === m.id);
      const e = String(m.e || "").slice(0, 8);
      if (!msg || !e) return;
      msg.r = msg.r || {};
      const a = new Set(msg.r[e] || []);
      const on = !a.has(me.cid);
      if (on) a.add(me.cid); else a.delete(me.cid);
      if (a.size) msg.r[e] = [...a]; else delete msg.r[e];
      saveChat(me.room, list);
      broadcast(me.room, { t: "re", id: msg.id, e, u: me.cid, on }, ws);
      return;
    }

    if (!RELAY.has(m.t)) return;
    if (m.t === "src") rooms[me.room].src = String(m.u || "").slice(0, 2000);
    if (m.t === "fmeta" && rooms[me.room]) rooms[me.room].src = "";
    m.from = me.id;
    broadcast(me.room, m, ws);
  });

  ws.on("close", () => {
    clients.delete(ws);
    if (me.room) { broadcast(me.room, { t: "bye", id: me.id }); announceMembers(me.room); }
  });
});

server.listen(PORT, "0.0.0.0", () => { sweep(); console.log(`Watch Party on http://0.0.0.0:${PORT}`); });
