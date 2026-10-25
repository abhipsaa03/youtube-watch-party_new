const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();

const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:5175",
  "http://localhost:5176",
];

app.use(cors({ origin: allowedOrigins }));
app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true,
  },
});

const rooms = new Map();

function makeRoomCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function getRoom(code) {
  return rooms.get(String(code || "").trim().toUpperCase());
}

function publicRoom(room) {
  return {
    roomId: room.id,
    videoId: room.videoId,
    playing: room.playing,
    currentTime: room.currentTime,
    participants: Array.from(room.participants.values()).map((p) => ({
      userId: p.userId,
      username: p.username,
      role: p.role,
    })),
  };
}

function sendRoomState(room) {
  io.to(room.id).emit("room_updated", publicRoom(room));

  io.to(room.id).emit("sync_state", {
    videoId: room.videoId,
    playing: room.playing,
    currentTime: room.currentTime,
  });
}

function validVideoId(id) {
  return typeof id === "string" && /^[a-zA-Z0-9_-]{11}$/.test(id);
}

function reply(callback, result) {
  if (typeof callback === "function") callback(result);
}

function removeFromRoom(socket, room) {
  room.participants.delete(socket.id);
  socket.leave(room.id);
  socket.data.roomId = null;
}

function finishEmptyRoom(room) {
  if (room.participants.size === 0) {
    rooms.delete(room.id);
    console.log("Room deleted:", room.id);
    return true;
  }

  return false;
}

// Assign a new Host when the current Host leaves.
function assignReplacementHost(room) {
  const participants = Array.from(room.participants.values());

  const next =
    participants.find((p) => p.role === "Moderator") ||
    participants[0];

  if (next) {
    next.role = "Host";
  }
}

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  socket.data.removedRooms = new Set();

  // CREATE ROOM
  socket.on("create_room", (payload = {}, callback) => {
    const username =
      typeof payload.username === "string" && payload.username.trim()
        ? payload.username.trim().slice(0, 30)
        : "Host";

    let code = makeRoomCode();

    while (rooms.has(code)) {
      code = makeRoomCode();
    }

    const room = {
      id: code,
      videoId: "",
      playing: false,
      currentTime: 0,
      participants: new Map(),
      chat: [],
    };

    room.participants.set(socket.id, {
      userId: socket.id,
      username,
      role: "Host",
    });

    rooms.set(code, room);
    socket.join(code);
    socket.data.roomId = code;
    socket.data.removedRooms.delete(code);

    reply(callback, {
      success: true,
      room: publicRoom(room),
      userId: socket.id,
    });

    sendRoomState(room);
    socket.emit("chat_history", room.chat);
  });

  // JOIN ROOM
  socket.on("join_room", (payload = {}, callback) => {
    const code = String(payload.roomId || "").trim().toUpperCase();
    const room = getRoom(code);

    if (!room) {
      return reply(callback, {
        error: "Room not found. Check the room code.",
      });
    }

    if (socket.data.removedRooms.has(code)) {
      return reply(callback, {
        error: "You were removed from this room and cannot rejoin using this connection.",
      });
    }

    // Leave the previous room, if any.
    const previousRoom = getRoom(socket.data.roomId);

    if (previousRoom) {
      const wasHost =
        previousRoom.participants.get(socket.id)?.role === "Host";

      removeFromRoom(socket, previousRoom);

      if (!finishEmptyRoom(previousRoom)) {
        if (wasHost) {
          assignReplacementHost(previousRoom);
        }

        sendRoomState(previousRoom);
      }
    }

    const username =
      typeof payload.username === "string" && payload.username.trim()
        ? payload.username.trim().slice(0, 30)
        : "Guest";

    room.participants.set(socket.id, {
      userId: socket.id,
      username,
      role: "Participant",
    });

    socket.join(code);
    socket.data.roomId = code;
    socket.data.removedRooms.delete(code);

    reply(callback, {
      success: true,
      room: publicRoom(room),
      userId: socket.id,
    });

    sendRoomState(room);
    socket.emit("chat_history", room.chat);
  });

  // CHAT MESSAGES, INCLUDING EMOJI TEXT
  socket.on("chat_message", (payload = {}, callback) => {
    const room = getRoom(socket.data.roomId);
    const participant = room?.participants.get(socket.id);
    const text = typeof payload.text === "string" ? payload.text.trim() : "";

    if (!room || !participant) {
      return reply(callback, {
        error: "Join a room before chatting.",
      });
    }

    if (!text) {
      return reply(callback, {
        error: "Message cannot be empty.",
      });
    }

    if (text.length > 500) {
      return reply(callback, {
        error: "Messages must be 500 characters or fewer.",
      });
    }

    const message = {
      id: `${Date.now()}-${socket.id}`,
      userId: socket.id,
      username: participant.username,
      role: participant.role,
      text,
      time: new Date().toISOString(),
    };

    room.chat.push(message);

    if (room.chat.length > 100) {
      room.chat.shift();
    }

    io.to(room.id).emit("chat_message", message);
    reply(callback, { success: true });
  });

  // QUICK EMOJI REACTIONS
  socket.on("emoji_reaction", (payload = {}, callback) => {
    const room = getRoom(socket.data.roomId);
    const participant = room?.participants.get(socket.id);

    const allowedEmojis = [
      "😂", "❤️", "🔥", "👍", "👎",
      "🎉", "😍", "😎", "👏", "😭",
      "😮", "🤣", "💯", "🥳", "🙌",
    ];

    if (!room || !participant) {
      return reply(callback, {
        error: "Join a room before reacting.",
      });
    }

    if (!allowedEmojis.includes(payload.emoji)) {
      return reply(callback, {
        error: "Unsupported emoji reaction.",
      });
    }

    io.to(room.id).emit("emoji_reaction", {
      id: `${Date.now()}-${socket.id}`,
      userId: socket.id,
      username: participant.username,
      emoji: payload.emoji,
    });

    reply(callback, { success: true });
  });

  // PROMOTE A PARTICIPANT TO MODERATOR
  socket.on("promote_moderator", (payload = {}, callback) => {
    const room = getRoom(socket.data.roomId);

    if (!room || room.participants.get(socket.id)?.role !== "Host") {
      return reply(callback, {
        error: "Only the host can assign moderators.",
      });
    }

    const target = room.participants.get(payload.userId);

    if (!target) {
      return reply(callback, {
        error: "Participant not found in this room.",
      });
    }

    if (target.userId === socket.id || target.role === "Host") {
      return reply(callback, {
        error: "The host cannot be promoted using this action.",
      });
    }

    target.role = "Moderator";

    sendRoomState(room);
    reply(callback, { success: true });
  });

  // TRANSFER HOST ROLE
  socket.on("transfer_host", (payload = {}, callback) => {
    const room = getRoom(socket.data.roomId);
    const currentHost = room?.participants.get(socket.id);

    if (!room || currentHost?.role !== "Host") {
      return reply(callback, {
        error: "Only the host can transfer the host role.",
      });
    }

    const target = room.participants.get(payload.userId);

    if (!target) {
      return reply(callback, {
        error: "Participant not found in this room.",
      });
    }

    if (target.userId === socket.id) {
      return reply(callback, {
        error: "You are already the host.",
      });
    }

    currentHost.role = "Participant";
    target.role = "Host";

    sendRoomState(room);

    reply(callback, { success: true });
  });

  // REMOVE PARTICIPANT
  socket.on("remove_participant", (payload = {}, callback) => {
    const room = getRoom(socket.data.roomId);

    if (!room || room.participants.get(socket.id)?.role !== "Host") {
      return reply(callback, {
        error: "Only the host can remove participants.",
      });
    }

    const targetId = String(payload.userId || "");
    const target = room.participants.get(targetId);

    if (!target) {
      return reply(callback, {
        error: "Participant not found in this room.",
      });
    }

    if (targetId === socket.id || target.role === "Host") {
      return reply(callback, {
        error: "You cannot remove the host.",
      });
    }

    const targetSocket = io.sockets.sockets.get(targetId);

    if (targetSocket) {
      targetSocket.emit("removed_from_room", {
        roomId: room.id,
        message: "The host removed you from this room.",
      });

      targetSocket.data.removedRooms.add(room.id);
      removeFromRoom(targetSocket, room);
    } else {
      room.participants.delete(targetId);
    }

    sendRoomState(room);
    finishEmptyRoom(room);

    reply(callback, { success: true });
  });

  // PLAYBACK: HOST AND MODERATOR
  socket.on("playback_action", (action = {}, callback) => {
    const room = getRoom(socket.data.roomId);

    if (!room) {
      return reply(callback, {
        error: "Join a room first.",
      });
    }

    const participant = room.participants.get(socket.id);

    if (
      !participant ||
      !["Host", "Moderator"].includes(participant.role)
    ) {
      return reply(callback, {
        error: "Only the host or moderator can control playback.",
      });
    }

    const time = Number(action.currentTime);

    if (action.type === "change_video") {
      if (!validVideoId(action.videoId)) {
        return reply(callback, {
          error: "Invalid YouTube video ID. Use an 11-character video ID.",
        });
      }

      room.videoId = action.videoId;
      room.currentTime = 0;
      room.playing = false;
    } else if (action.type === "play") {
      room.playing = true;

      if (Number.isFinite(time) && time >= 0) {
        room.currentTime = time;
      }
    } else if (action.type === "pause") {
      room.playing = false;

      if (Number.isFinite(time) && time >= 0) {
        room.currentTime = time;
      }
    } else if (action.type === "seek") {
      if (!Number.isFinite(time) || time < 0) {
        return reply(callback, {
          error: "Invalid playback position.",
        });
      }

      room.currentTime = time;
      if (typeof action.playing === "boolean") {
        room.playing = action.playing;
      }
    } else {
      return reply(callback, {
        error: "Unknown playback action.",
      });
    }

    sendRoomState(room);
    reply(callback, { success: true });
  });

  // LEAVE ROOM
  socket.on("leave_room", (payload = {}, callback = () => {}) => {
    const room = getRoom(socket.data.roomId);

    if (!room) {
      socket.data.roomId = null;
      return reply(callback, { success: true });
    }

    const wasHost =
      room.participants.get(socket.id)?.role === "Host";

    removeFromRoom(socket, room);

    if (!finishEmptyRoom(room)) {
      if (wasHost) {
        assignReplacementHost(room);
      }

      sendRoomState(room);
    }

    reply(callback, { success: true });
  });

  // DISCONNECT
  socket.on("disconnect", () => {
    const room = getRoom(socket.data.roomId);

    if (!room) {
      console.log("Disconnected:", socket.id);
      return;
    }

    const wasHost =
      room.participants.get(socket.id)?.role === "Host";

    room.participants.delete(socket.id);
    socket.data.roomId = null;

    if (finishEmptyRoom(room)) {
      console.log("Disconnected:", socket.id);
      return;
    }

    if (wasHost) {
      assignReplacementHost(room);
    }

    sendRoomState(room);
    console.log("Disconnected:", socket.id);
  });
});

app.get("/", (_req, res) => {
  res.json({ status: "WatchTogether server is running" });
});

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});