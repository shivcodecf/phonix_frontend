// src/App.jsx
import React, { useState, useEffect, useRef } from "react";
import { createClient } from "@supabase/supabase-js";
import { Socket, Presence } from "phoenix";

/* --- Env (Vite) --- */
const RAW_SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const RAW_SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const RAW_API_URL = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");
const RAW_WS_URL = (import.meta.env.VITE_WS_URL || "").replace(/\/$/, "");

/* --- Compute base URLs --- */
const API_BASE = RAW_API_URL || "";
const WS_BASE =
  RAW_WS_URL ||
  (API_BASE
    ? (API_BASE.startsWith("https") ? "wss" : "ws") + "://" + API_BASE.replace(/^https?:\/\//, "") + "/socket"
    : "/socket");

const normalizeApiBase = (u) => (u ? u.replace(/\/$/, "") : "");

/* --- Supabase client --- */
if (!RAW_SUPABASE_URL || !RAW_SUPABASE_ANON_KEY) {
  console.warn("⚠️ VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY not set. Supabase features will be limited.");
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

  /* ----------------- session helpers ----------------- */
  const tokenIsExpired = (session) => {
    if (!session) return true;
    // supabase may store expires_at in seconds
    const expires = session.expires_at ?? session.expires ?? null;
    if (!expires) return true;
    return (expires * 1000) - Date.now() < 30_000; // expire threshold 30s
  };

  const ensureFreshSession = async () => {
    if (!supabase) return null;
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return null;
      if (!tokenIsExpired(session)) return session;

      // try refreshSession if available
      if (typeof supabase.auth.refreshSession === "function") {
        try {
          const r = await supabase.auth.refreshSession();
          return r.data?.session || null;
        } catch (e) {
          console.warn("refreshSession failed", e);
        }
      }

      // fallback: call getSession again (some clients auto refresh)
      const { data: { session: again } } = await supabase.auth.getSession();
      return again || null;
    } catch (e) {
      console.warn("ensureFreshSession error", e);
      return null;
    }
  };

  /* ----------------- lifecycle: restore session & selected chat ----------------- */
  useEffect(() => {
    (async () => {
      try {
        if (!supabase) return;

        const { data: { session } } = await supabase.auth.getSession();
        if (session) {
          setUser(session.user);
          await fetchUserChats(session.user.id);

          const persisted = localStorage.getItem("chat:last");
          if (persisted) {
            // ensure user is member of persisted chat
            const { data: memberships } = await supabase
              .from("chat_members")
              .select("chat_id")
              .eq("user_id", session.user.id);

            const ids = new Set((memberships || []).map((m) => m.chat_id));
            if (ids.has(persisted)) {
              // selectChat handles history + socket connect
              await selectChat(persisted, session);
            } else {
              console.debug("persisted chat not available for user:", persisted);
            }
          }
        }
      } catch (err) {
        console.error("session restore error", err);
      }
    })();

    // subscribe auth state changes
    let authSub;
    if (supabase && typeof supabase.auth.onAuthStateChange === "function") {
      authSub = supabase.auth.onAuthStateChange((_event, session) => {
        if (session) {
          setUser(session.user);
          fetchUserChats(session.user.id);
          // try restore chat if none selected
          const persisted = localStorage.getItem("chat:last");
          if (persisted && !currentChat) {
            selectChat(persisted).catch(() => {});
          }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ----------------- auth actions ----------------- */
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

  /* ----------------- fetch chats ----------------- */
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

  /* ----------------- socket / presence ----------------- */
  const disconnectSocket = () => {
    try { channelRef.current?.leave(); } catch {}
    try { socketRef.current?.disconnect(); } catch {}
    channelRef.current = null;
    socketRef.current = null;
    presenceRef.current = null;
  };

  const connectSocket = async (token, chatId, { retry = true } = {}) => {
    if (!token || !chatId) {
      console.warn("connectSocket missing token or chatId");
      return;
    }

    disconnectSocket();
    const socket = new Socket(WS_BASE, { params: { token } });
    socket.connect();
    socketRef.current = socket;

    const channel = socket.channel(`chat:${chatId}`, {});
    channel.join()
      .receive("ok", () => console.log("✅ joined", chatId))
      .receive("error", async (err) => {
        console.error("❌ join error", err);
        const maybeExpired =
          (err?.reason && String(err.reason).toLowerCase().includes("jwt")) ||
          (err?.message && String(err.message).toLowerCase().includes("expired")) ||
          (err?.status === 401) || (err?.status === 403);
        if (maybeExpired && retry) {
          const fresh = await ensureFreshSession();
          if (fresh?.access_token) {
            console.log("Retrying socket join with refreshed token");
            connectSocket(fresh.access_token, chatId, { retry: false });
          } else {
            console.warn("Could not refresh session for socket join; user may need to re-login");
          }
        }
      });

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

  /* ----------------- history ----------------- */
  const loadHistory = async (chatId) => {
    if (!supabase) {
      console.warn("Supabase client not configured; skipping history load");
      setMessages([]);
      return [];
    }

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      console.debug("no session available; skipping history load");
      setMessages([]);
      return [];
    }

    const apiBase = normalizeApiBase(API_BASE) || "";
    const url = `${apiBase}/api/history?chat_id=${encodeURIComponent(chatId)}`;
    console.debug("loading history from", url);

    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${session.access_token}` } });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const msg = `history fetch failed: ${res.status} ${res.statusText} ${text ? "- " + text : ""}`;
        console.error(msg);
        throw new Error(msg);
      }

      const body = await res.json().catch(e => {
        console.error("History load: invalid json", e);
        return null;
      });

      console.debug("history response body:", body);

      // Accept a few shapes: { items: [...] } or direct array or { data: [...] }
      const items = Array.isArray(body?.items) ? body.items
                   : Array.isArray(body)            ? body
                   : Array.isArray(body?.data)      ? body.data
                   : [];

      // canonicalize a bit
      const normalized = items.map((it) => ({
        id: it.id ?? null,
        chat_id: it.chat_id ?? chatId,
        sender_id: it.sender_id ?? it.user_id ?? "unknown",
        content: it.content ?? "",
        inserted_at: it.inserted_at ?? null,
        client_msg_id: it.client_msg_id ?? null,
      }));

      setMessages(normalized);
      return normalized;
    } catch (err) {
      console.error("History load error", err);
      setMessages([]);
      return [];
    }
  };

  /* ----------------- select chat ----------------- */
  const selectChat = async (chatId, sessionArg = null) => {
    setCurrentChat(chatId);
    localStorage.setItem("chat:last", chatId);

    // ensure we have fresh session for socket token
    const fresh = sessionArg || (await ensureFreshSession());
    if (!fresh) {
      console.warn("No session available to connect socket; please login.");
      // still attempt to load history if possible (some APIs may not require auth)
      await loadHistory(chatId).catch(() => {});
      return;
    }

    // load history first, then connect socket (avoids race)
    await loadHistory(chatId).catch(() => {});
    connectSocket(fresh.access_token, chatId);
  };

  /* ----------------- send message ----------------- */
  const sendMessage = () => {
    if (!channelRef.current || !input.trim()) return;
    channelRef.current.push("new_message", { content: input });
    setInput("");
  };

  /* ----------------- UI ----------------- */
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
          <p style={{ color: "gray" }}>API: {API_BASE || "(relative)"} WS: {WS_BASE}</p>
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
