import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

function loadLocalEnvFile() {
  const thisFile = fileURLToPath(import.meta.url);
  const thisDir = path.dirname(thisFile);
  const possibleEnvPaths = [
    path.resolve(process.cwd(), ".env"),
    path.resolve(thisDir, ".env"),
  ];

  for (const envPath of possibleEnvPaths) {
    if (!fs.existsSync(envPath)) continue;

    const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex <= 0) continue;

      const key = trimmed.slice(0, eqIndex).trim();
      const rawValue = trimmed.slice(eqIndex + 1).trim();
      if (!key || process.env[key]) continue;
      process.env[key] = rawValue;
    }
  }
}

loadLocalEnvFile();

const app = express();
const httpServer = createServer(app);

const PORT = process.env.PORT || 4000;
const FRONTEND_ORIGIN = normalizeOrigin(process.env.FRONTEND_ORIGIN || "*");
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const ROOM_CODE_LENGTH = 6;
const ROOM_CHARSET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const SYNC_BROADCAST_INTERVAL_MS = 2500;

app.use(
  cors({
    origin: FRONTEND_ORIGIN === "*" ? true : [FRONTEND_ORIGIN, `${FRONTEND_ORIGIN}/`],
    credentials: true,
  })
);
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "watchparty-backend" });
});

app.get("/", (_req, res) => {
  res.json({
    status: "ok",
    service: "watchparty-backend",
    message: "Backend is running. Use /health and /api/* endpoints.",
  });
});

app.get("/api/youtube/search", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) {
    return res.status(400).json({ message: "Query is required" });
  }

  if (!YOUTUBE_API_KEY) {
    return res.status(500).json({ message: "YOUTUBE_API_KEY is missing on backend" });
  }

  try {
    const endpoint = new URL("https://www.googleapis.com/youtube/v3/search");
    endpoint.searchParams.set("part", "snippet");
    endpoint.searchParams.set("type", "video");
    endpoint.searchParams.set("maxResults", "12");
    endpoint.searchParams.set("q", q);
    endpoint.searchParams.set("key", YOUTUBE_API_KEY);

    const response = await fetch(endpoint);
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      return res.status(response.status === 403 ? 429 : 502).json({
        message: errorData?.error?.message || "YouTube API request failed",
      });
    }

    const data = await response.json();
    const results = mapYouTubeItems(data.items || []);

    return res.json({ results });
  } catch (error) {
    return res.status(502).json({ message: "YouTube API unavailable" });
  }
});

app.get("/api/youtube/related", async (req, res) => {
  const videoId = String(req.query.videoId || "").trim();
  const requestedChannelId = String(req.query.channelId || "").trim();
  if (!videoId) {
    return res.status(400).json({ message: "videoId is required" });
  }

  if (!YOUTUBE_API_KEY) {
    return res.status(500).json({ message: "YOUTUBE_API_KEY is missing on backend" });
  }

  try {
    let channelId = requestedChannelId;

    if (!channelId) {
      const videoDetailsEndpoint = new URL("https://www.googleapis.com/youtube/v3/videos");
      videoDetailsEndpoint.searchParams.set("part", "snippet");
      videoDetailsEndpoint.searchParams.set("id", videoId);
      videoDetailsEndpoint.searchParams.set("key", YOUTUBE_API_KEY);

      const videoDetailsResp = await fetch(videoDetailsEndpoint);
      if (videoDetailsResp.ok) {
        const videoDetailsData = await videoDetailsResp.json();
        channelId = videoDetailsData?.items?.[0]?.snippet?.channelId || "";
      }
    }

    if (channelId) {
      const channelVideosEndpoint = new URL("https://www.googleapis.com/youtube/v3/search");
      channelVideosEndpoint.searchParams.set("part", "snippet");
      channelVideosEndpoint.searchParams.set("type", "video");
      channelVideosEndpoint.searchParams.set("maxResults", "20");
      channelVideosEndpoint.searchParams.set("channelId", channelId);
      channelVideosEndpoint.searchParams.set("order", "date");
      channelVideosEndpoint.searchParams.set("key", YOUTUBE_API_KEY);

      const channelVideosResp = await fetch(channelVideosEndpoint);
      if (channelVideosResp.ok) {
        const channelVideosData = await channelVideosResp.json();
        const channelResults = mapYouTubeItems(channelVideosData.items || []).filter((item) => item.videoId !== videoId);
        if (channelResults.length > 0) {
          return res.json({ results: channelResults, source: "channel" });
        }
      }
    }

    // Fallback so UI never stays empty.
    const relatedEndpoint = new URL("https://www.googleapis.com/youtube/v3/search");
    relatedEndpoint.searchParams.set("part", "snippet");
    relatedEndpoint.searchParams.set("type", "video");
    relatedEndpoint.searchParams.set("maxResults", "20");
    relatedEndpoint.searchParams.set("relatedToVideoId", videoId);
    relatedEndpoint.searchParams.set("key", YOUTUBE_API_KEY);

    const relatedResp = await fetch(relatedEndpoint);
    if (!relatedResp.ok) {
      const errorData = await relatedResp.json().catch(() => ({}));
      return res.status(relatedResp.status === 403 ? 429 : 502).json({
        message: errorData?.error?.message || "YouTube related API failed",
      });
    }

    const relatedData = await relatedResp.json();
    const relatedResults = mapYouTubeItems(relatedData.items || []).filter((item) => item.videoId !== videoId);
    return res.json({ results: relatedResults, source: "related-fallback" });
  } catch {
    return res.status(502).json({ message: "YouTube API unavailable" });
  }
});

function mapYouTubeItems(items) {
  return items
    .map((item) => ({
      videoId: item?.id?.videoId,
      channelId: item?.snippet?.channelId || "",
      title: item?.snippet?.title || "",
      channelTitle: item?.snippet?.channelTitle || "",
      thumbnail:
        item?.snippet?.thumbnails?.medium?.url ||
        item?.snippet?.thumbnails?.default?.url ||
        "",
    }))
    .filter((item) => Boolean(item.videoId));
}

const io = new Server(httpServer, {
  cors: {
    origin: FRONTEND_ORIGIN === "*" ? true : [FRONTEND_ORIGIN, `${FRONTEND_ORIGIN}/`],
    credentials: true,
  },
});

const rooms = new Map();

function getOrCreateRoom(roomCode) {
  if (!rooms.has(roomCode)) {
    rooms.set(roomCode, {
      roomCode,
      videoId: "dQw4w9WgXcQ",
      isPlaying: false,
      currentTime: 0,
      lastUpdatedAt: Date.now(),
      chat: [],
    });
  }
  return rooms.get(roomCode);
}

function normalizeOrigin(value) {
  const text = String(value || "").trim();
  if (!text || text === "*") return "*";
  return text.replace(/\/+$/, "");
}

function normalizeRoomCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function isValidRoomCode(code) {
  return /^[A-Z0-9]{6}$/.test(code);
}

function generateRoomCode() {
  let output = "";
  for (let i = 0; i < ROOM_CODE_LENGTH; i += 1) {
    const index = Math.floor(Math.random() * ROOM_CHARSET.length);
    output += ROOM_CHARSET[index];
  }
  return output;
}

function getUniqueRoomCode() {
  let attempts = 0;
  while (attempts < 1000) {
    const code = generateRoomCode();
    if (!rooms.has(code)) return code;
    attempts += 1;
  }
  throw new Error("Could not generate unique room code");
}

function getSyncedTime(state) {
  if (!state.isPlaying) return state.currentTime;
  const elapsed = (Date.now() - state.lastUpdatedAt) / 1000;
  return state.currentTime + elapsed;
}

function buildSyncPayload(state) {
  return {
    isPlaying: state.isPlaying,
    currentTime: getSyncedTime(state),
    serverNow: Date.now(),
  };
}

app.post("/api/rooms/create", (req, res) => {
  try {
    const roomCode = getUniqueRoomCode();
    const requestedVideoId = String(req.body?.videoId || "").trim();
    const state = getOrCreateRoom(roomCode);
    if (requestedVideoId) {
      state.videoId = requestedVideoId;
      state.currentTime = 0;
      state.isPlaying = false;
      state.lastUpdatedAt = Date.now();
    }

    res.status(201).json({
      roomCode,
      videoId: state.videoId,
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to create room" });
  }
});

app.get("/api/rooms/:roomCode", (req, res) => {
  const roomCode = normalizeRoomCode(req.params.roomCode);
  if (!isValidRoomCode(roomCode)) {
    return res.status(400).json({ message: "Invalid room code format" });
  }

  if (!rooms.has(roomCode)) {
    return res.status(404).json({ message: "Room not found" });
  }

  const state = getOrCreateRoom(roomCode);
  return res.json({
    roomCode,
    videoId: state.videoId,
    isPlaying: state.isPlaying,
    currentTime: getSyncedTime(state),
  });
});

io.on("connection", (socket) => {
  socket.on("join-room", ({ roomCode, username }) => {
    const normalizedCode = normalizeRoomCode(roomCode);
    const cleanName = String(username || "").trim();

    if (!cleanName || !isValidRoomCode(normalizedCode)) {
      socket.emit("join-error", { message: "Invalid room code or username" });
      return;
    }

    if (!rooms.has(normalizedCode)) {
      socket.emit("join-error", { message: "Room does not exist" });
      return;
    }

    socket.data.roomCode = normalizedCode;
    socket.data.username = cleanName;
    socket.join(normalizedCode);

    const state = getOrCreateRoom(normalizedCode);

    socket.emit("room-state", {
      roomCode: normalizedCode,
      videoId: state.videoId,
      ...buildSyncPayload(state),
      chat: state.chat.slice(-50),
    });

    io.to(normalizedCode).emit("system-message", {
      text: `${cleanName} joined`,
      at: Date.now(),
    });
  });

  socket.on("set-video", ({ videoId }) => {
    const { roomCode, username } = socket.data;
    if (!roomCode || !videoId) return;

    const state = getOrCreateRoom(roomCode);
    state.videoId = videoId;
    state.currentTime = 0;
    state.isPlaying = false;
    state.lastUpdatedAt = Date.now();

    io.to(roomCode).emit("video-changed", {
      videoId,
      by: username,
      at: Date.now(),
    });
  });

  socket.on("sync-play", ({ currentTime }) => {
    const { roomCode } = socket.data;
    if (!roomCode) return;

    const state = getOrCreateRoom(roomCode);
    state.isPlaying = true;
    state.currentTime = Number(currentTime) || 0;
    state.lastUpdatedAt = Date.now();

    socket.to(roomCode).emit("sync-play", {
      ...buildSyncPayload(state),
    });
  });

  socket.on("sync-pause", ({ currentTime }) => {
    const { roomCode } = socket.data;
    if (!roomCode) return;

    const state = getOrCreateRoom(roomCode);
    state.isPlaying = false;
    state.currentTime = Number(currentTime) || 0;
    state.lastUpdatedAt = Date.now();

    socket.to(roomCode).emit("sync-pause", {
      ...buildSyncPayload(state),
    });
  });

  socket.on("sync-seek", ({ currentTime }) => {
    const { roomCode } = socket.data;
    if (!roomCode) return;

    const state = getOrCreateRoom(roomCode);
    state.currentTime = Number(currentTime) || 0;
    state.lastUpdatedAt = Date.now();

    socket.to(roomCode).emit("sync-seek", {
      ...buildSyncPayload(state),
    });
  });

  socket.on("chat-message", ({ text }) => {
    const { roomCode, username } = socket.data;
    if (!roomCode || !username || !text?.trim()) return;

    const state = getOrCreateRoom(roomCode);
    const message = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      username,
      text: text.trim().slice(0, 500),
      at: Date.now(),
    };

    state.chat.push(message);
    if (state.chat.length > 200) state.chat = state.chat.slice(-200);

    io.to(roomCode).emit("chat-message", message);
  });

  socket.on("disconnect", () => {
    const { roomCode, username } = socket.data;
    if (!roomCode || !username) return;

    io.to(roomCode).emit("system-message", {
      text: `${username} left`,
      at: Date.now(),
    });
  });
});

setInterval(() => {
  for (const [roomCode, state] of rooms.entries()) {
    io.to(roomCode).emit("sync-state", buildSyncPayload(state));
  }
}, SYNC_BROADCAST_INTERVAL_MS);

httpServer.listen(PORT, () => {
  console.log(`watchparty backend running on ${PORT}`);
});
