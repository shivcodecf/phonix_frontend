import { Socket } from "phoenix";

// Connect to Phoenix socket
let socket = new Socket("ws://localhost:4000/socket", {
  params: { token: "test" } // in prod use Supabase JWT
});

socket.connect();

export default socket;
