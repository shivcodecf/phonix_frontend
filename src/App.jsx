// src/App.jsx
import React, { useState, useEffect, useRef } from "react";
import { createClient } from "@supabase/supabase-js";
import { Socket, Presence } from "phoenix";

/* --- Env (Vite) --- */
const RAW_SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const RAW_SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const RAW_API_URL = import.meta.env.VITE_API_URL;
const RAW_WS_URL = import.meta.env.VITE_WS_URL;

/* --- Use relative paths when proxying --- */
const API_URL = RAW_API_URL || "";     // empty => use relative "/api/..."
const WS_URL = RAW_WS_URL || "/socket"; // empty => use relative "/socket"

/* --- Helpers --- */
const normalizeApiBase = (u) => (u ? u.replace(/\/$/, "") : u);

/* --- Supabase client (safe) --- */
if (!RAW_SUPABASE_URL || !RAW_SUPABASE_ANON_KEY) {
  console.warn("⚠️ VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY not set.");
}
const supabase = (() => {
  try {
    return createClient(RAW_SUPABASE_URL || "", RAW_SUPABASE_ANON_KEY || "");
  } catch (err) {
    console.error("Failed to create Supabase client:", err);
    return null;
  }
})();

/* --- Main App --- */
export default function App() {
  const [user, setUser] = useState(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [chats, setChats] = useState([]);
  const [currentChat, setCurrentChat] = useState(null);

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");

  const [inviteEmails, setInviteEmails] = useState("");
  const [onlineUsers, setOnlineUsers] = useState([]);

  const socketRef = useRef(null);
  const channelRef = useRef(null);
  const presenceRef = useRef(null);

  /* Session restore + auth change listener */
  useEffect(() => {
    (async () => {
      try {
        if (!supabase) return;
        const { data: { session } } = await supabase.auth.getSession();
        if (session) {
          setUser(session.user);
          await fetchUserChats(session.user.id);
        }
      } catch (err) {
        console.error("session restore error", err);
      }
    })();

    let authSub;
    if (supabase) {
      authSub = supabase.auth.onAuthStateChange((_event, session) => {
        if (session) {
          setUser(session.user);
          fetchUserChats(session.user.id);
        } else {
          setUser(null);
          setChats([]);
          setMessages([]);
          setOnlineUsers([]);
          disconnectSocket();
          try { supabase.removeAllChannels(); } catch {}
        }
      });
    }

    return () => {
      try { authSub?.subscription?.unsubscribe(); } catch {}
    };
  }, []);

  /* --- Auth --- */
  const signup = async () => {
    if (!supabase) return alert("Supabase not configured.");
    const { error } = await supabase.auth.signUp({ email, password });
    if (error) return alert("Signup error: " + error.message);
    alert("✅ Signup ok — please login.");
  };

  const login = async () => {
    if (!supabase) return alert("Supabase not configured.");
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return alert("Login error: " + error.message);
    setUser(data.user);
    await fetchUserChats(data.user.id);
  };

  const logout = async () => {
    if (!supabase) return;
    await supabase.auth.signOut();
    setUser(null);
    setChats([]);
    setMessages([]);
    setOnlineUsers([]);
    disconnectSocket();
    try { supabase.removeAllChannels(); } catch {}
  };

  /* --- Fetch chats --- */
  const fetchUserChats = async (userId) => {
    if (!supabase) return setChats([]);
    const { data, error } = await supabase
      .from("chat_members")
      .select("chat_id,chats(name,id)")
      .eq("user_id", userId);
    if (error) return console.error("fetchUserChats error", error);
    setChats((data || []).map((c) => ({ id: c.chat_id, name: c.chats?.name || "Unnamed Chat" })));
  };

  const createChat = async () => {
    if (!supabase || !user) return alert("Not authenticated.");
    const name = prompt("Chat name:");
    if (!name) return;
    const { data: newChat, error: cErr } = await supabase.from("chats").insert({ name }).select().single();
    if (cErr) return alert("Create chat failed: " + cErr.message);
    await supabase.from("chat_members").insert({ chat_id: newChat.id, user_id: user.id });
    await fetchUserChats(user.id);
    alert("✅ Chat created.");
  };

  const inviteMembers = async () => {
    if (!supabase || !currentChat) return;
    const emails = inviteEmails.split(",").map((s) => s.trim()).filter(Boolean);
    for (const mail of emails) {
      const { data: profile } = await supabase.from("profiles").select("id").eq("email", mail).maybeSingle();
      if (profile) {
        await supabase.from("chat_members").insert({ chat_id: currentChat, user_id: profile.id });
      }
    }
    setInviteEmails("");
    alert("✅ Invites processed.");
  };

  /* --- Socket / Presence --- */
  const disconnectSocket = () => {
    try { channelRef.current?.leave(); } catch {}
    try { socketRef.current?.disconnect(); } catch {}
    channelRef.current = null;
    socketRef.current = null;
    presenceRef.current = null;
  };

  const connectSocket = (token, chatId) => {
    disconnectSocket();
    const socket = new Socket(WS_URL, { params: { token } });
    socket.connect();
    socketRef.current = socket;

    const channel = socket.channel(`chat:${chatId}`, {});
    channel.join()
      .receive("ok", () => console.log("✅ joined", chatId))
      .receive("error", (err) => console.error("❌ join error", err));

    channel.on("new_message", (msg) => {
      setMessages((prev) => [...prev, msg]);
    });

    const presence = new Presence(channel);
    presence.onSync(() => {
      const users = [];
      presence.list((id, { metas }) => {
        const m = metas?.[0] || {};
        users.push({ id, email: m.email || m.user_id || id });
      });
      setOnlineUsers(users);
    });

    channelRef.current = channel;
    presenceRef.current = presence;
  };

  /* --- History --- */
  const loadHistory = async (chatId) => {
    if (!supabase) return;
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;
    const res = await fetch(`/api/history?chat_id=${chatId}`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    if (!res.ok) throw new Error("history fetch failed: " + res.status);
    setMessages(await res.json());
  };

  const selectChat = async (chatId) => {
    setCurrentChat(chatId);
    const { data: { session } } = await supabase.auth.getSession();
    if (session) {
      connectSocket(session.access_token, chatId);
      await loadHistory(chatId);
    }
  };

  const sendMessage = () => {
    if (!channelRef.current || !input.trim()) return;
    channelRef.current.push("new_message", { content: input });
    setInput("");
  };

  /* --- UI --- */
  return (
    <div style={{ padding: 20 }}>
      {!user ? (
        <div>
          <h2>Login / Signup</h2>
          <input placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} /><br />
          <input type="password" placeholder="password" value={password} onChange={(e) => setPassword(e.target.value)} /><br />
          <button onClick={login}>Login</button>
          <button onClick={signup} style={{ marginLeft: 8 }}>Signup</button>
          <p style={{ color: "gray" }}>Supabase: {RAW_SUPABASE_URL}</p>
          <p style={{ color: "gray" }}>API → proxy /api | WS → proxy /socket</p>
        </div>
      ) : (
        <div>
          <h2>Welcome {user.email}</h2>
          <button onClick={logout}>Logout</button>
          <button onClick={createChat} style={{ marginLeft: 10 }}>➕ Create Chat</button>

          <div style={{ marginTop: 12 }}>
            <h4>Your Chats</h4>
            {chats.length === 0 ? <p>No chats</p> : (
              <select value={currentChat || ""} onChange={(e) => selectChat(e.target.value)}>
                <option value="">Select a chat</option>
                {chats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            )}
          </div>

          {currentChat && (
            <>
              <div style={{ marginTop: 12 }}>
                <h4>Invite members</h4>
                <input value={inviteEmails} onChange={(e) => setInviteEmails(e.target.value)} placeholder="a@x.com, b@y.com" />
                <button onClick={inviteMembers} style={{ marginLeft: 8 }}>Invite</button>
              </div>

              <div style={{ marginTop: 12 }}>
                <h4>Online users</h4>
                <ul>{onlineUsers.map((u) => <li key={u.id}>{u.email || u.id}</li>)}</ul>
              </div>

              <div style={{ marginTop: 12, border: "1px solid #ccc", padding: 8, height: 240, overflowY: "auto" }}>
                {messages.map((m, i) => <div key={i}><b>{m.sender_id || "anon"}</b>: {m.content}</div>)}
              </div>

              <div style={{ marginTop: 8 }}>
                <input style={{ width: "70%" }} value={input} onChange={(e) => setInput(e.target.value)} />
                <button onClick={sendMessage} style={{ marginLeft: 8 }}>Send</button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
