require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const fs = require("fs");
const path = require("path");

// ─── Provider Setup ────────────────────────────────────────────
const providerName = (process.env.AI_PROVIDER || "gemini").toLowerCase();
let provider;

const GeminiProvider = require("./providers/gemini");
provider = new GeminiProvider();

// ─── System Prompt ─────────────────────────────────────────────
function getSystemPrompt() {
  if (process.env.SYSTEM_PROMPT) {
    return process.env.SYSTEM_PROMPT;
  }

  const promptPath = path.join(__dirname, "system-prompt.md");
  if (fs.existsSync(promptPath)) {
    return fs.readFileSync(promptPath, "utf-8").trim();
  }

  return "You are a helpful AI assistant.";
}

const systemPrompt = getSystemPrompt();

// ─── Tactician System Prompt ───────────────────────────────────
function getTacticianPrompt() {
  const promptPath = path.join(__dirname, "tactician-prompt.md");
  if (fs.existsSync(promptPath)) {
    return fs.readFileSync(promptPath, "utf-8").trim();
  }
  return "You are a soccer tactical analyst. Analyze the game state and return JSON with insights for all 22 players.";
}

const tacticianPrompt = getTacticianPrompt();

// ─── Express App ───────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 3001;

app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: false,
}));

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim())
  : ["*"];

app.use(cors({
  origin: allowedOrigins.includes("*") ? true : allowedOrigins,
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"],
}));

app.use(express.json({ limit: "50kb" }));

const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000,
  max: parseInt(process.env.RATE_LIMIT_MAX) || 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many requests. Please wait a moment and try again.",
  },
});

app.use("/api/", limiter);

// ─── Validation Middleware ─────────────────────────────────────
const MAX_MESSAGE_LENGTH = 4000;
const MAX_HISTORY_LENGTH = 50;

function validateChatBody(req, res, next) {
  const { messages } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({
      error: "Request must include a non-empty 'messages' array.",
    });
  }

  if (messages.length > MAX_HISTORY_LENGTH) {
    return res.status(400).json({
      error: `Too many messages. Maximum ${MAX_HISTORY_LENGTH} messages per request.`,
    });
  }

  for (const msg of messages) {
    if (!msg.role || !msg.content) {
      return res.status(400).json({
        error: "Each message must have 'role' and 'content' properties.",
      });
    }

    if (!["user", "assistant"].includes(msg.role)) {
      return res.status(400).json({
        error: "Message role must be 'user' or 'assistant'.",
      });
    }

    if (typeof msg.content !== "string" || msg.content.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({
        error: `Message content must be a string under ${MAX_MESSAGE_LENGTH} characters.`,
      });
    }
  }

  next();
}

// ─── Static Files & Routes ───────────────────────────────────────
app.use(express.static(path.join(__dirname, "../public")));

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    provider: provider.getInfo(),
    uptime: process.uptime(),
  });
});

app.post("/api/chat", validateChatBody, async (req, res) => {
  try {
    const { messages } = req.body;
    const response = await provider.chat(messages, systemPrompt);

    res.json({
      response,
      provider: providerName,
    });
  } catch (error) {
    console.error("Chat error:", error.message);
    res.status(500).json({
      error: "Something went wrong. Please try again.",
    });
  }
});

app.post("/api/chat/stream", validateChatBody, async (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  let isClientConnected = true;
  req.on("close", () => {
    isClientConnected = false;
  });

  try {
    const { messages } = req.body;

    await provider.stream(
      messages,
      systemPrompt,
      (text) => {
        if (isClientConnected) {
          res.write(`data: ${JSON.stringify({ type: "chunk", content: text })}\n\n`);
        }
      },
      () => {
        if (isClientConnected) {
          res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
          res.end();
        }
      },
      (error) => {
        console.error("Stream error:", error.message);
        if (isClientConnected) {
          res.write(
            `data: ${JSON.stringify({ type: "error", content: "Something went wrong. Please try again." })}\n\n`
          );
          res.end();
        }
      }
    );
  } catch (error) {
    console.error("Stream setup error:", error.message);
    if (isClientConnected) {
      res.write(
        `data: ${JSON.stringify({ type: "error", content: "Failed to start response. Please try again." })}\n\n`
      );
      res.end();
    }
  }
});

// ─── Tactician Endpoint ────────────────────────────────────────
app.post("/api/tactician", async (req, res) => {
  try {
    const { phase, ballZone, selectedPosition, hasBall, setPiece, playerPositions, opponentPositions } = req.body;

    if (!phase || !ballZone) {
      return res.status(400).json({
        error: "Request must include 'phase' and 'ballZone'.",
      });
    }

    // Build a structured game state message for Gemini
    const stateDescription = [
      `## Current Game State`,
      `- **Phase of Play:** ${phase === 'possession' ? 'IN POSSESSION (Attacking)' : 'OUT OF POSSESSION (Defending)'}`,
      `- **Ball Location:** ${ballZone}`,
      `- **Selected/Focus Player:** ${selectedPosition || 'RW'}`,
      `- **Selected Player Has Ball:** ${hasBall ? 'Yes' : 'No'}`,
      `- **Set Piece:** ${setPiece && setPiece !== 'none' ? setPiece.replace('_', ' ').toUpperCase() : 'None (Open Play)'}`,
      ``,
      `## Your Team Player Positions (x=0 is left touchline, x=100 is right touchline, y=0 is opponent goal line, y=100 is own goal line):`,
      ...(playerPositions
        ? Object.entries(playerPositions).map(([pos, coords]) => `- ${pos}: x=${Math.round(coords.x)}, y=${Math.round(coords.y)}`)
        : ['Positions not provided — use standard 4-3-3 positions based on ball zone.']),
      ``,
      `## Opponent Team Positions:`,
      ...(opponentPositions
        ? Object.entries(opponentPositions).map(([pos, coords]) => `- ${pos}: x=${Math.round(coords.x)}, y=${Math.round(coords.y)}`)
        : ['Opponent positions not provided — assume standard defensive shape.']),
      ``,
      `Analyze this game state NOW. Remember: respond with ONLY valid JSON, no markdown fences, no extra text.`
    ].join('\n');

    const messages = [{ role: "user", content: stateDescription }];
    const rawResponse = await provider.chat(messages, tacticianPrompt);

    // Try to parse JSON from the response (handle possible markdown fences)
    let analysis;
    try {
      analysis = JSON.parse(rawResponse);
    } catch {
      // Try extracting JSON from markdown code block
      const jsonMatch = rawResponse.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        analysis = JSON.parse(jsonMatch[1].trim());
      } else {
        // Last resort: find first { to last }
        const start = rawResponse.indexOf('{');
        const end = rawResponse.lastIndexOf('}');
        if (start !== -1 && end !== -1) {
          analysis = JSON.parse(rawResponse.substring(start, end + 1));
        } else {
          throw new Error("Could not parse Gemini response as JSON");
        }
      }
    }

    res.json({
      analysis,
      provider: providerName,
    });
  } catch (error) {
    console.error("Tactician error:", error.message);
    res.status(500).json({
      error: "Tactical analysis failed. Please try again.",
      detail: error.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`\n🤖 Chatbot server running on port ${PORT}`);
  console.log(`   Provider: ${providerName}`);
  console.log(`   Model:    ${provider.getInfo().model}`);
  console.log(`   Health:   http://localhost:${PORT}/health\n`);
});
