import React, { useEffect, useState } from "react";
import socket from "./socket";

const Chat = () => {
  const [channel, setChannel] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");

  useEffect(() => {
    // Join the channel
    let channel = socket.channel("chat:room1", {});

    channel.join()
      .receive("ok", resp => console.log("✅ Joined successfully", resp))
      .receive("error", resp => console.error("❌ Unable to join", resp));

    // Listen for new messages
    channel.on("new_message", (msg) => {
      setMessages(prev => [...prev, msg]);
    });

    setChannel(channel);

    return () => {
      channel.leave();
    };
  }, []);

  // Send a message
  const sendMessage = () => {
    if (input.trim() !== "") {
      channel.push("new_message", { content: input });
      setInput("");
    }
  };

  return (
    <div style={{ padding: "20px", maxWidth: "500px", margin: "auto" }}>
      <h2>💬 Chat Room (room1)</h2>
      <div
        style={{
          border: "1px solid #ddd",
          height: "300px",
          overflowY: "scroll",
          padding: "10px",
          marginBottom: "10px"
        }}
      >
        {messages.map((msg, idx) => (
          <div key={idx}>
            <b>{msg.sender_id}:</b> {msg.content}
          </div>
        ))}
      </div>
      <input
        style={{ width: "70%", padding: "5px" }}
        value={input}
        onChange={e => setInput(e.target.value)}
        placeholder="Type a message..."
      />
      <button onClick={sendMessage} style={{ padding: "5px 10px" }}>
        Send
      </button>
    </div>
  );
};

export default Chat;
