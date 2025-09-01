import React, { useState, useEffect, useRef } from "react";
import { createClient } from "@supabase/supabase-js";
import { Socket, Presence } from "phoenix";

// ✅ Supabase client
const supabase = createClient(
  "https://psvhvupdhtzglueldsze.supabase.co", // your Supabase URL
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBzdmh2dXBkaHR6Z2x1ZWxkc3plIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTU0MDc4NjYsImV4cCI6MjA3MDk4Mzg2Nn0.KUsKFcFbPUcpCLRiZaZsAKgZKLEA8DHtb6PpHQNAp1E" // ⚠️ replace with your anon key
);

function App() {
  const [user, setUser] = useState(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");

  const [chats, setChats] = useState([]);
  const [currentChat, setCurrentChat] = useState(null);

  const [inviteEmails, setInviteEmails] = useState("");
  const [onlineUsers, setOnlineUsers] = useState([]);
  const channelRef = useRef(null);
  const socketRef = useRef(null);
  const presenceRef = useRef(null);

  // 🔹 Restore session + subscribe to realtime
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        setUser(session.user);
        fetchUserChats(session.user.id, session.access_token);
        subscribeToChats(session.user.id);
      }
    });

    const { data: subscription } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        if (session) {
          setUser(session.user);
          fetchUserChats(session.user.id, session.access_token);
          subscribeToChats(session.user.id);
        } else {
          setUser(null);
          setMessages([]);
          setChats([]);
          setOnlineUsers([]);
          disconnectSocket();
          supabase.removeAllChannels();
        }
      }
    );

    return () => subscription.subscription.unsubscribe();
  }, []);

  // 🔹 Auth
  const login = async () => {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return alert("Login error: " + error.message);
    setUser(data.user);
    fetchUserChats(data.user.id, data.session.access_token);
    subscribeToChats(data.user.id);
  };

  const signup = async () => {
    const { error } = await supabase.auth.signUp({ email, password });
    if (error) return alert("Signup error: " + error.message);
    alert("✅ Signup successful, please login.");
  };

  const logout = async () => {
    await supabase.auth.signOut();
    setUser(null);
    setChats([]);
    setMessages([]);
    setOnlineUsers([]);
    disconnectSocket();
    supabase.removeAllChannels();
  };

  // 🔹 Fetch user’s chats
  const fetchUserChats = async (userId, token) => {
    const res = await fetch(
      `https://psvhvupdhtzglueldsze.supabase.co/rest/v1/chat_members?user_id=eq.${userId}&select=chat_id,chats(name,id)`,
      {
        headers: {
          apikey: supabase.supabaseKey,
          Authorization: `Bearer ${token}`,
        },
      }
    );
    const data = await res.json();
    setChats(data.map((c) => ({ id: c.chat_id, name: c.chats?.name || "Unnamed Chat" })));
  };

  // 🔹 Realtime subscription for chat_members
  const subscribeToChats = (userId) => {
    supabase
      .channel("chat_members_changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "chat_members", filter: `user_id=eq.${userId}` },
        async () => {
          const { data: { session } } = await supabase.auth.getSession();
          if (session) {
            fetchUserChats(userId, session.access_token);
          }
        }
      )
      .subscribe();
  };

  // 🔹 Create new chat
  const createChat = async () => {
    const chatName = prompt("Enter chat name:");
    if (!chatName) return;

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;

    const { data: newChat, error: chatErr } = await supabase
      .from("chats")
      .insert({ name: chatName })
      .select()
      .single();

    if (chatErr) return alert("Chat creation failed: " + chatErr.message);

    const { error: memErr } = await supabase
      .from("chat_members")
      .insert({ chat_id: newChat.id, user_id: session.user.id });

    if (memErr) return alert("Failed to join new chat: " + memErr.message);

    fetchUserChats(session.user.id, session.access_token);
    alert("✅ New chat created!");
  };

  // 🔹 Invite members by email
  const inviteMembers = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session || !currentChat) return;

    const emails = inviteEmails.split(",").map((e) => e.trim()).filter(Boolean);

    for (let mail of emails) {
      const { data: userData, error: lookupErr } = await supabase
        .from("profiles")
        .select("id")
        .eq("email", mail)
        .maybeSingle();

      if (lookupErr || !userData) {
        console.warn(`❌ User not found: ${mail}`);
        continue;
      }

      const { error: memErr } = await supabase
        .from("chat_members")
        .insert({ chat_id: currentChat, user_id: userData.id });

      if (memErr) {
        console.error(`❌ Could not add ${mail}:`, memErr.message);
      } else {
        console.log(`✅ Added ${mail} to chat`);
      }
    }

    setInviteEmails("");
    alert("✅ Invites processed.");
  };

  // 🔹 Disconnect socket
  const disconnectSocket = () => {
    if (channelRef.current) {
      channelRef.current.leave();
      channelRef.current = null;
    }
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }
  };

  // 🔹 Connect WebSocket + presence
  const connectSocket = (token, chatId) => {
    disconnectSocket();

    const socket = new Socket("ws://localhost:4000/socket", { params: { token } });
    socket.connect();
    socketRef.current = socket;

    const channel = socket.channel(`chat:${chatId}`, {});
    channel.join()
      .receive("ok", () => console.log(`✅ Joined chat ${chatId}`))
      .receive("error", (err) => console.error("❌ Join error:", err));

    channel.on("new_message", (msg) => {
      setMessages((prev) => [...prev, msg]);
    });

    // 🔹 Presence tracking
    const presence = new Presence(channel);
    presence.onSync(() => {
      const users = [];
      presence.list((id, { metas }) => {
        users.push({ id, email: metas[0].email });
      });
      setOnlineUsers(users);
    });

    channelRef.current = channel;
    presenceRef.current = presence;
  };

  // 🔹 Load chat history
  const loadHistory = async (token, chatId) => {
    try {
      const res = await fetch(`http://localhost:4000/api/history?chat_id=${chatId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Failed to fetch history");
      const data = await res.json();
      setMessages(data);
    } catch (err) {
      console.error("History load error:", err);
    }
  };

  // 🔹 Select chat
  const selectChat = async (chatId) => {
    setCurrentChat(chatId);
    const { data: { session } } = await supabase.auth.getSession();
    if (session) {
      connectSocket(session.access_token, chatId);
      loadHistory(session.access_token, chatId);
    }
  };

  // 🔹 Send message
  const sendMessage = () => {
    if (channelRef.current && input.trim() !== "") {
      channelRef.current.push("new_message", { content: input });
      setInput("");
    }
  };

  return (
    <div style={{ padding: "20px" }}>
      {!user ? (
        <div>
          <h2>Login / Signup</h2>
          <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} /><br />
          <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} /><br />
          <button onClick={login}>Login</button>
          <button onClick={signup}>Signup</button>
        </div>
      ) : (
        <div>
          <h2>Welcome {user.email}</h2>
          <button onClick={logout}>Logout</button>
          <button onClick={createChat} style={{ marginLeft: "10px" }}>➕ Create New Chat</button>

          <div style={{ marginTop: "10px" }}>
            <h3>Your Chats</h3>
            {chats.length === 0 ? (
              <p>⚠️ You are not in any chats.</p>
            ) : (
              <select onChange={(e) => selectChat(e.target.value)} value={currentChat || ""}>
                <option value="">Select a chat</option>
                {chats.map((c, i) => (
                  <option key={i} value={c.id}>{c.name}</option>
                ))}
              </select>
            )}
          </div>

          {/* ✅ Invite members */}
          {currentChat && (
            <div style={{ marginTop: "10px" }}>
              <h4>Invite Members (comma separated emails)</h4>
              <input
                type="text"
                placeholder="friend1@mail.com, friend2@mail.com"
                value={inviteEmails}
                onChange={(e) => setInviteEmails(e.target.value)}
              />
              <button onClick={inviteMembers}>Invite</button>
            </div>
          )}

          {/* ✅ Online Users */}
          {currentChat && (
            <div style={{ marginTop: "10px" }}>
              <h4>👥 Online Users</h4>
              <ul>
                {onlineUsers.map((u, i) => (
                  <li key={i}>{u.email || u.id}</li>
                ))}
              </ul>
            </div>
          )}

          {/* ✅ Messages */}
          {currentChat && (
            <>
              <div style={{
                border: "1px solid #ccc",
                padding: "10px",
                height: "200px",
                overflowY: "scroll",
                marginTop: "10px",
                marginBottom: "10px",
              }}>
                {messages.map((msg, i) => (
                  <div key={i}>
                    <b>{msg.sender_id || "anon"}:</b> {msg.content}
                  </div>
                ))}
              </div>
              <input
                type="text"
                placeholder="Type a message..."
                value={input}
                onChange={(e) => setInput(e.target.value)}
              />
              <button onClick={sendMessage}>Send</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default App;
