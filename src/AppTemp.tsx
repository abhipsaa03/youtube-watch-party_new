import { useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import "./App.css";

declare global {
  interface Window {
    YT: any;
    onYouTubeIframeAPIReady?: () => void;
  }
}

const SERVER_URL = (import.meta.env.VITE_SERVER_URL || "http://localhost:3001").replace(/\/$/, "");

type Participant = {
  userId: string;
  username?: string;
  role: string;
};

type RoomState = {
  roomId: string;
  videoId: string;
  playing: boolean;
  currentTime: number;
  participants: Participant[];
};

type ChatMessage = {
  userId: string;
  username: string;
  text: string;
  role?: string;
  timestamp?: number;
  time?: string;
};

type EmojiReaction = {
  id: string;
  userId: string;
  username: string;
  emoji: string;
};

const CHAT_EMOJIS = ["😀", "😂", "😍", "🥳", "🔥", "❤️", "👍", "👏", "😮", "😭", "🎉", "🙌"];
const QUICK_REACTIONS = ["😂", "❤️", "🔥", "👍", "🎉", "😍", "👏", "😮"];

function extractVideoId(input: string): string | null {
  const value = input.trim();

  if (/^[\w-]{11}$/.test(value)) return value;

  try {
    const url = new URL(value);
    let id: string | null = null;

    if (url.hostname === "youtu.be") {
      id = url.pathname.split("/").filter(Boolean)[0] || null;
    } else if (
      url.hostname === "youtube.com" ||
      url.hostname.endsWith(".youtube.com") ||
      url.hostname === "youtube-nocookie.com"
    ) {
      if (url.pathname === "/watch") {
        id = url.searchParams.get("v");
      } else {
        id =
          url.pathname.match(/^\/(?:embed|shorts|live)\/([^/]+)/)?.[1] ||
          null;
      }
    }

    return id && /^[\w-]{11}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

function App() {
  const socketRef = useRef<Socket | null>(null);
  const playerRef = useRef<any>(null);
  const roomRef = useRef<RoomState | null>(null);
  const playerReadyRef = useRef(false);
  const lastVideoRef = useRef("");
  const applyingRemoteRef = useRef(false);

  const [username, setUsername] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [videoUrl, setVideoUrl] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [room, setRoom] = useState<RoomState | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [emojiReactions, setEmojiReactions] = useState<EmojiReaction[]>([]);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [connected, setConnected] = useState(false);
  const [message, setMessage] = useState("");

  const myId = socketRef.current?.id;
  const myRole =
    room?.participants.find((p) => p.userId === myId)?.role || "Participant";
  const isHost = myRole === "Host";
  const canControl = isHost || myRole === "Moderator";

  function updateRoom(state: RoomState) {
    roomRef.current = state;
    setRoom(state);
  }

  function stopPlayer() {
    const player = playerRef.current;
    playerRef.current = null;
    playerReadyRef.current = false;
    lastVideoRef.current = "";
    applyingRemoteRef.current = false;

    try {
      player?.stopVideo?.();
      player?.destroy?.();
    } catch (error) {
      console.warn("YouTube player cleanup:", error);
    }
  }

  // Connect to Socket.IO and listen for server events.
  useEffect(() => {
    const socket = io(SERVER_URL);
    socketRef.current = socket;

    socket.on("connect", () => {
      setConnected(true);
      setMessage("");
    });

    socket.on("disconnect", () => {
      setConnected(false);
      setMessage("Server disconnected. Check the backend terminal.");
    });

    socket.on("connect_error", () => {
      setConnected(false);
      setMessage("Cannot connect to localhost:3001.");
    });

    socket.on("room_updated", (state: RoomState) => updateRoom(state));

    socket.on("chat_history", (history: ChatMessage[]) => {
      setChatMessages(Array.isArray(history) ? history.slice(-100) : []);
    });

    socket.on("chat_message", (chat: ChatMessage) => {
      setChatMessages((previous) => [...previous, chat].slice(-100));
    });

    socket.on("emoji_reaction", (reaction: EmojiReaction) => {
      setEmojiReactions((previous) => [...previous, reaction].slice(-20));
    });

    socket.on("removed_from_room", (data: { message?: string }) => {
      stopPlayer();
      roomRef.current = null;
      setRoom(null);
      setChatMessages([]);
      setMessage(data?.message || "You were removed from the room.");
    });

    socket.on(
      "sync_state",
      (state: { videoId: string; playing: boolean; currentTime: number }) => {
        const player = playerRef.current;
        // roomRef is updated by room_updated; if the iframe is not ready yet,
        // onReady will apply that latest room state instead of dropping sync.
        if (!playerReadyRef.current || !player) return;

        applyingRemoteRef.current = true;

        if (state.videoId !== lastVideoRef.current) {
          lastVideoRef.current = state.videoId;

          if (!state.videoId) {
            player.stopVideo?.();
          } else {
            player.loadVideoById({
              videoId: state.videoId,
              startSeconds: Math.max(0, state.currentTime || 0),
            });

            if (!state.playing) {
              window.setTimeout(() => playerRef.current?.pauseVideo?.(), 500);
            }
          }
        } else if (state.videoId) {
          const actual = player.getCurrentTime?.() ?? 0;
          const target = Math.max(0, state.currentTime || 0);

          if (Math.abs(actual - target) > 2) {
            player.seekTo(target, true);
          }

          if (state.playing) player.playVideo?.();
          else player.pauseVideo?.();
        }

        window.setTimeout(() => {
          applyingRemoteRef.current = false;
        }, 800);
      }
    );

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
      stopPlayer();
    };
  }, []);

  // Load the YouTube IFrame API once a room is open.
  useEffect(() => {
    if (!room) return;

    let cancelled = false;

    function createPlayer() {
      if (cancelled || !window.YT?.Player) return;
      if (!document.getElementById("youtube-player")) return;
      if (playerRef.current) return;

      playerRef.current = new window.YT.Player("youtube-player", {
        width: "100%",
        height: "100%",
        videoId: "",
        playerVars: {
          playsinline: 1,
          controls: 1,
          enablejsapi: 1,
          origin: window.location.origin,
        },
        events: {
          onReady: () => {
            if (cancelled) return;
            playerReadyRef.current = true;

            const state = roomRef.current;
            if (state?.videoId) {
              lastVideoRef.current = state.videoId;
              playerRef.current.loadVideoById({
                videoId: state.videoId,
                startSeconds: state.currentTime || 0,
              });

              if (!state.playing) {
                window.setTimeout(() => playerRef.current?.pauseVideo?.(), 500);
              }
            }
          },
          onStateChange: (event: any) => {
            // Keep the local room snapshot fresh. Remote sync operations are
            // ignored here to prevent playback feedback loops.
            if (applyingRemoteRef.current) return;
            const player = playerRef.current;
            if (!player || !roomRef.current) return;
            if (event.data === 1 || event.data === 2) {
              const currentTime = Number(player.getCurrentTime?.() ?? 0);
              if (Number.isFinite(currentTime)) {
                roomRef.current = {
                  ...roomRef.current,
                  currentTime,
                  playing: event.data === 1,
                };
              }
            }
          },
          onError: (event: any) => {
            setMessage(
              `YouTube error ${event.data}. Try another video that permits embedding.`
            );
          },
        },
      });
    }

    if (window.YT?.Player) {
      createPlayer();
    } else {
      const existing = document.querySelector(
        'script[src="https://www.youtube.com/iframe_api"]'
      );

      window.onYouTubeIframeAPIReady = createPlayer;

      if (!existing) {
        const script = document.createElement("script");
        script.src = "https://www.youtube.com/iframe_api";
        document.head.appendChild(script);
      }
    }

    return () => {
      cancelled = true;
    };
  }, [Boolean(room)]);

  function requestRoom(event: "create_room" | "join_room", id?: string) {
    const socket = socketRef.current;

    if (!socket?.connected) {
      setMessage("Server is disconnected. Start the backend first.");
      return;
    }

    if (event === "join_room" && !id?.trim()) {
      setMessage("Enter a room code.");
      return;
    }

    socket.emit(
      event,
      {
        username: username.trim() || "Guest",
        roomId: id?.trim().toUpperCase(),
      },
      (result: any) => {
        if (result?.error) {
          setMessage(result.error);
          return;
        }

        if (result?.room) {
          updateRoom(result.room);
          setChatMessages([]);
          setMessage("");
        }
      }
    );
  }

  function playback(type: "play" | "pause" | "seek" | "change_video") {
    const socket = socketRef.current;
    const currentRoom = roomRef.current;

    if (!socket?.connected || !currentRoom) {
      setMessage("Join a room first.");
      return;
    }

    if (!canControl) {
      setMessage("Your role cannot control playback.");
      return;
    }

    const payload: Record<string, any> = { type };

    if (type === "change_video") {
      const id = extractVideoId(videoUrl);
      if (!id) {
        setMessage("Enter a valid YouTube URL or video ID.");
        return;
      }
      payload.videoId = id;
    } else {
      payload.currentTime = playerReadyRef.current
        ? playerRef.current?.getCurrentTime?.() ?? currentRoom.currentTime
        : currentRoom.currentTime;
      if (type === "seek" && playerReadyRef.current) {
        payload.playing = playerRef.current?.getPlayerState?.() === 1;
      }
    }

    socket.emit("playback_action", payload, (result: any) => {
      setMessage(result?.error || "");
    });
  }

  function sendChat(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = chatInput.trim();
    const socket = socketRef.current;

    if (!text || !roomRef.current || !socket?.connected) return;

    socket.emit("chat_message", { text }, (result: any) => {
      if (result?.error) setMessage(result.error);
      else {
        setChatInput("");
        setMessage("");
      }
    });
  }

  function assignRole(userId: string, role: "Moderator" | "Participant") {
    if (!isHost) return;

    socketRef.current?.emit(
      "promote_moderator",
      { userId, role },
      (result: any) => {
        setMessage(result?.error || "");
      }
    );
  }

  function removeParticipant(person: Participant) {
    if (!isHost || person.role === "Host" || person.userId === myId) return;

    if (!window.confirm(`Remove ${person.username || "this participant"}?`)) {
      return;
    }

    socketRef.current?.emit(
      "remove_participant",
      { userId: person.userId },
      (result: any) => setMessage(result?.error || "")
    );
  }

  function leaveRoom() {
    const socket = socketRef.current;

    const resetLocalRoom = () => {
      stopPlayer();
      roomRef.current = null;
      setRoom(null);
      setChatMessages([]);
      setEmojiReactions([]);
      setChatInput("");
      setVideoUrl("");
      setRoomCode("");
      setMessage("You left the room.");
    };

    if (!socket?.connected) {
      resetLocalRoom();
      return;
    }

    socket.emit("leave_room", {}, (result: any) => {
      if (result?.error) {
        setMessage(result.error);
        return;
      }
      resetLocalRoom();
    });
  }

  function addEmoji(emoji: string) {
    setChatInput((current) => `${current}${emoji}`);
    setEmojiPickerOpen(false);
  }

  function sendReaction(emoji: string) {
    socketRef.current?.emit("emoji_reaction", { emoji }, (result: any) => {
      if (result?.error) setMessage(result.error);
    });
  }

  return (
    <main className="dashboard">
      <header className="topbar">
        <div>
          <h1>WatchTogether</h1>
          <p>Watch videos together, wherever you are.</p>
        </div>
        <span className={connected ? "status online" : "status"}>
          {connected ? "Connected" : "Disconnected"}
        </span>
      </header>

      {!room ? (
        <section className="join-card">
          <h2>Create or join a room</h2>

          <label htmlFor="username">Your name</label>
          <input
            id="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="Enter your name"
            maxLength={30}
          />

          <button
            disabled={!connected}
            onClick={() => requestRoom("create_room")}
          >
            Create room
          </button>

          <div className="separator">OR</div>

          <label htmlFor="room-code">Room code</label>
          <input
            id="room-code"
            value={roomCode}
            onChange={(event) => setRoomCode(event.target.value.toUpperCase())}
            placeholder="Enter room code"
            maxLength={8}
          />

          <button
            disabled={!connected}
            onClick={() => requestRoom("join_room", roomCode)}
          >
            Join room
          </button>
        </section>
      ) : (
        <>
          <div className="room-heading">
            <div>
              <h2>Room: {room.roomId}</h2>
              <p>Your role: <strong>{myRole}</strong></p>
            </div>

            <div className="room-actions">
              <button
                className="secondary"
                onClick={() =>
                  navigator.clipboard
                    .writeText(room.roomId)
                    .then(() => setMessage("Room code copied."))
                    .catch(() => setMessage(`Room code: ${room.roomId}`))
                }
              >
                Copy room code
              </button>
              <button className="secondary" onClick={leaveRoom}>
                Leave room
              </button>
            </div>
          </div>

          <div className="watch-layout">
            <section className="watch-main">
              <div className="video-frame">
                <div id="youtube-player" />
                {!room.videoId && (
                  <div className="video-placeholder">
                    <span>▶</span>
                    <p>Waiting for the host to load a video</p>
                  </div>
                )}
              </div>

              {canControl && (
                <>
                  <form
                    className="video-input"
                    onSubmit={(event) => {
                      event.preventDefault();
                      playback("change_video");
                    }}
                  >
                    <input
                      value={videoUrl}
                      onChange={(event) => setVideoUrl(event.target.value)}
                      placeholder="Paste a YouTube video URL"
                    />
                    <button type="submit">Load video</button>
                  </form>

                  <div className="controls">
                    <button
                      disabled={!room.videoId}
                      onClick={() => playback("play")}
                    >
                      ▶ Play
                    </button>
                    <button
                      className="secondary"
                      disabled={!room.videoId}
                      onClick={() => playback("pause")}
                    >
                      ⏸ Pause
                    </button>
                    <button
                      className="secondary"
                      disabled={!room.videoId}
                      onClick={() => playback("seek")}
                    >
                      Sync position
                    </button>
                  </div>
                </>
              )}

              <section className="panel reaction-panel">
                <h3>Quick reactions</h3>
                <div className="emoji-buttons">
                  {QUICK_REACTIONS.map((emoji) => (
                    <button
                      type="button"
                      className="emoji-button"
                      key={emoji}
                      onClick={() => sendReaction(emoji)}
                      aria-label={`Send ${emoji} reaction`}
                      title={`React ${emoji}`}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
                {emojiReactions.length > 0 && (
                  <div className="reaction-feed" aria-live="polite">
                    {emojiReactions.slice(-8).map((reaction) => (
                      <span className="reaction-item" key={reaction.id}>
                        {reaction.emoji} <small>{reaction.username}</small>
                      </span>
                    ))}
                  </div>
                )}
              </section>

              {!canControl && (
                <p className="hint">
                  You can watch and chat. A Host or Moderator controls playback.
                </p>
              )}
            </section>

            <aside className="watch-sidebar">
              <section className="panel participants">
                <h3>Participants ({room.participants.length})</h3>

                {room.participants.map((person) => (
                  <div className="participant" key={person.userId}>
                    <div className="participant-info">
                      <span className="participant-name">
                        {person.userId === myId
                          ? `${person.username || "You"} (You)`
                          : person.username || person.userId.slice(0, 8)}
                      </span>
                      <span
                        className={`role-badge ${person.role.toLowerCase()}`}
                      >
                        {person.role}
                      </span>
                    </div>

                    {isHost &&
                      person.role !== "Host" &&
                      person.userId !== myId && (
                        <div className="participant-actions">
                          <select
                            aria-label={`Role for ${person.username || "participant"}`}
                            value={person.role}
                            onChange={(event) =>
                              assignRole(
                                person.userId,
                                event.target.value as
                                  | "Moderator"
                                  | "Participant"
                              )
                            }
                          >
                            <option value="Participant">Participant</option>
                            <option value="Moderator">Moderator</option>
                          </select>
                          <button
                            className="small-button danger"
                            onClick={() => removeParticipant(person)}
                          >
                            Remove
                          </button>
                        </div>
                      )}
                  </div>
                ))}
              </section>

              <section className="panel chat-panel">
                <h3>Live chat</h3>

                <div className="chat-messages" aria-live="polite">
                  {chatMessages.length === 0 ? (
                    <p className="chat-empty">
                      No messages yet. Start the conversation!
                    </p>
                  ) : (
                    chatMessages.map((chat, index) => (
                      <div
                        className="chat-message"
                        key={`${chat.userId}-${chat.timestamp ?? index}-${index}`}
                      >
                        <div className="chat-message-heading">
                          <strong>{chat.username || "Guest"}</strong>
                          <span
                            className={`role-badge ${(chat.role || "Participant").toLowerCase()}`}
                          >
                            {chat.role || "Participant"}
                          </span>
                        </div>
                        <p>{chat.text}</p>
                      </div>
                    ))
                  )}
                </div>

                {emojiPickerOpen && (
                  <div className="chat-emoji-picker" aria-label="Choose an emoji">
                    {CHAT_EMOJIS.map((emoji) => (
                      <button
                        type="button"
                        className="emoji-button"
                        key={emoji}
                        onClick={() => addEmoji(emoji)}
                        aria-label={`Insert ${emoji}`}
                      >
                        {emoji}
                      </button>
                    ))}
                  </div>
                )}

                <form className="chat-form" onSubmit={sendChat}>
                  <button
                    type="button"
                    className="secondary emoji-toggle"
                    onClick={() => setEmojiPickerOpen((open) => !open)}
                    aria-label="Toggle emoji picker"
                    title="Add emoji"
                  >
                    😀
                  </button>
                  <input
                    value={chatInput}
                    onChange={(event) => setChatInput(event.target.value)}
                    placeholder="Write a message..."
                    maxLength={500}
                    aria-label="Chat message"
                  />
                  <button type="submit" disabled={!chatInput.trim()}>
                    Send
                  </button>
                </form>
              </section>
            </aside>
          </div>
        </>
      )}

      {message && <p className="message" role="status">{message}</p>}
    </main>
  );
}

export default App;
