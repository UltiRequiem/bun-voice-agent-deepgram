import { createClient, AgentEvents } from "@deepgram/sdk";
import { WebSocket } from "ws";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

// Load environment variables
dotenv.config();

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

if (!DEEPGRAM_API_KEY) {
  console.error("Please set your DEEPGRAM_API_KEY in the .env file");
  process.exit(1);
}

// Initialize Deepgram
const deepgram = createClient(DEEPGRAM_API_KEY);

const serverIndex = path.join(__dirname, "../static/index.html");

// Create HTTP server to serve the static files
const server = http.createServer((req, res) => {
  const staticDir = path.join(__dirname, "../static");
  let filePath = "";
  let contentType = "text/html";

  switch (req.url) {
    case "/":
      filePath = path.join(staticDir, "index.html");
      contentType = "text/html";
      break;
    case "/styles.css":
      filePath = path.join(staticDir, "styles.css");
      contentType = "text/css";
      break;
    case "/app.js":
      filePath = path.join(staticDir, "app.js");
      contentType = "application/javascript";
      break;
    default:
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not Found" }));
      return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(500);
      res.end(`Error loading ${req.url}`);
      return;
    }

    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  });
});

const propmt = `This GPT functions as a conversational module for Mappa, a platform dedicated to analyzing behavior through voice. It must operate strictly in English. It begins with a greeting where it introduces itself as Maria, the assistant from Mappa. It then asks for the user's name to establish a more natural and personal rapport. After the name is provided, it continues with a second question about the user’s profession. Once that’s answered, it follows up with a third question designed to reveal interpersonal qualities such as communication, leadership, or emotional empathy—without directly referencing 'soft skills'. For example, it might ask, 'In your work as a [profession], how do you typically collaborate with colleagues?' All questions are asked one at a time, adapting naturally to the user’s responses. If answers are vague or unclear, Maria may ask follow-up questions. At the end, it provides a polite closing and informs the user that a report will be sent to their email. The tone should be professional yet approachable, resembling a cordial exchange with a trusted specialist. It must avoid any topics that are inappropriate in a professional context, such as unrelated personal matters, politics, religion, or sensitive content not tied to the workplace.
`;

// Function to connect to Deepgram Voice Agent
async function connectToAgent() {
  try {
    // Create an agent connection
    const agent = deepgram.agent();

    // Set up event handlers
    agent.on(AgentEvents.Open, () => {
      console.log("Agent connection established");
    });

    agent.on("Welcome", (data) => {
      console.log("Server welcome message:", data);
      agent.configure({
        audio: {
          input: {
            encoding: "linear16",
            sample_rate: 24000,
          },
          output: {
            encoding: "linear16",
            sample_rate: 24000,
            container: "none",
          },
        },
        agent: {
          listen: {
            provider: {
              type: "deepgram",
              model: "nova-3",
            },
          },
          think: {
            provider: {
              type: "open_ai",
              model: "gpt-4o-mini",
            },
            prompt: `${propmt} -> Remember that you have a voice interface. You can listen and speak, and all your responses will be spoken aloud.`,
          },
          speak: {
            provider: {
              type: "deepgram",
              model: "aura-2-thalia-en",
            },
          },
          greeting: "Hello! How can I help you today?",
        },
      });
    });

    agent.on("SettingsApplied", (data) => {
      console.log("Server confirmed settings:", data);
    });

    agent.on(
      AgentEvents.AgentStartedSpeaking,
      (data: { total_latency: number }) => {
        // Remove unnecessary latency logging
      }
    );

    agent.on(
      AgentEvents.ConversationText,
      (message: { role: string; content: string }) => {
        // Log the conversation text for debugging
        console.log(`${message.role}: ${message.content}`);

        // Send conversation text to browser
        if (browserWs?.readyState === WebSocket.OPEN) {
          try {
            const messageData = {
              type:
                message.role === "user" ? "user_transcript" : "agent_response",
              [message.role === "user" ? "transcript" : "text"]:
                message.content,
              timestamp: new Date().toISOString(),
            };
            browserWs.send(JSON.stringify(messageData));
          } catch (error) {
            console.error("Error sending conversation text to browser:", error);
          }
        }
      }
    );

    agent.on(AgentEvents.Audio, (audio: Buffer) => {
      if (browserWs?.readyState === WebSocket.OPEN) {
        try {
          // Send the audio buffer directly without additional conversion
          browserWs.send(audio, { binary: true });
        } catch (error) {
          console.error("Error sending audio to browser:", error);
        }
      }
    });

    agent.on(AgentEvents.Error, (error: Error) => {
      console.error("Agent error:", error);
    });

    agent.on(AgentEvents.Close, () => {
      console.log("Agent connection closed");
      if (browserWs?.readyState === WebSocket.OPEN) {
        browserWs.close();
      }
    });

    return agent;
  } catch (error) {
    console.error("Error connecting to Deepgram:", error);
    process.exit(1);
  }
}

// Create WebSocket server for browser clients
const wss = new WebSocket.Server({ server });
let browserWs: WebSocket | null = null;

wss.on("connection", async (ws) => {
  // Only log critical connection events
  console.log("Browser client connected");
  browserWs = ws;

  const agent = await connectToAgent();

  ws.on("message", (data: Buffer) => {
    try {
      if (agent) {
        agent.send(data.buffer);
      }
    } catch (error) {
      console.error("Error sending audio to agent:", error);
    }
  });

  ws.on("close", async () => {
    if (agent) {
      agent.disconnect();
    }
    browserWs = null;
    console.log("Browser client disconnected");
  });

  ws.on("error", (error) => {
    console.error("WebSocket error:", error);
  });
});

// Start the server
const PORT = process.env.PORT || 3000;
const serverInstance = server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

// Graceful shutdown handler
function shutdown() {
  console.log("\nShutting down server...");

  // Set a timeout to force exit if graceful shutdown takes too long
  const forceExit = setTimeout(() => {
    console.error("Force closing due to timeout");
    process.exit(1);
  }, 5000);

  // Track pending operations
  const pendingOps = {
    ws: true,
    http: true,
  };

  // Function to check if all operations are complete
  const checkComplete = () => {
    if (!pendingOps.ws && !pendingOps.http) {
      clearTimeout(forceExit);
      console.log("Server shutdown complete");
      process.exit(0);
    }
  };

  // Close all WebSocket connections
  for (const client of wss.clients) {
    try {
      client.close();
    } catch (err) {
      console.error("Error closing WebSocket client:", err);
    }
  }

  wss.close((err) => {
    if (err) {
      console.error("Error closing WebSocket server:", err);
    } else {
      console.log("WebSocket server closed");
    }
    pendingOps.ws = false;
    checkComplete();
  });

  // Close the HTTP server
  serverInstance.close((err) => {
    if (err) {
      console.error("Error closing HTTP server:", err);
    } else {
      console.log("HTTP server closed");
    }
    pendingOps.http = false;
    checkComplete();
  });
}

// Handle shutdown signals
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

export default serverInstance;
