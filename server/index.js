require("dotenv").config();
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const { createTranscriptLogger } = require("./transcriptLogger");

const app = express();
const PORT = process.env.PORT || 3000;
const MODEL =
  process.env.MODEL || "gpt-4o-realtime-preview-2024-12-17";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VOICE = process.env.SANTA_VOICE || "cedar";
const CHILD_PROFILE_PATH =
  process.env.CHILD_PROFILE_PATH ||
  path.join(__dirname, "..", "data", "child-profile.txt");
const TRANSCRIPT_DIR =
  process.env.TRANSCRIPT_DIR || path.join("data", "transcripts");

const transcriptLogger = createTranscriptLogger(
  path.resolve(__dirname, "..", TRANSCRIPT_DIR)
);

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(
  express.static(path.join(__dirname, "..", "public"), {
    extensions: ["html"],
  })
);

// Ensure the child profile file exists so the session handler can read it.
ensureChildProfileFile(CHILD_PROFILE_PATH);

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

// Read current child profile
app.get("/api/profile", async (_req, res) => {
  const child = await loadChildProfile(CHILD_PROFILE_PATH);
  res.json({ child });
});

// Update child profile on disk
app.post("/api/profile", async (req, res) => {
  const child = req.body?.child || {};
  try {
    await saveChildProfile(CHILD_PROFILE_PATH, child);
    const saved = await loadChildProfile(CHILD_PROFILE_PATH);
    res.json({ child: saved });
  } catch (error) {
    console.error("Failed to save child profile", error);
    res.status(500).json({ error: "Could not save child profile" });
  }
});

/**
 * Create an ephemeral client token for the browser to open a Realtime
 * session directly with OpenAI over WebRTC. Also allocate a transcript file
 * for the call.
 */
app.post("/api/session", async (req, res) => {
  if (!OPENAI_API_KEY) {
    return res
      .status(500)
      .json({ error: "OPENAI_API_KEY missing from environment." });
  }

  const child = await loadChildProfile(CHILD_PROFILE_PATH);
  console.log("Loaded child profile", { child, from: CHILD_PROFILE_PATH });
  const sessionId = crypto.randomUUID();
  await transcriptLogger.startSession(sessionId, child);

  const instructions = buildSantaInstructions(child);

  try {
    const openaiResponse = await fetch(
      "https://api.openai.com/v1/realtime/sessions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
          "OpenAI-Beta": "realtime=v1",
        },
        body: JSON.stringify({
          model: MODEL,
          voice: VOICE,
          // Transcription ensures we get text back for logging
          input_audio_transcription: {
            model: "gpt-4o-mini-transcribe",
          },
        }),
      }
    );

    if (!openaiResponse.ok) {
      const errText = await openaiResponse.text();
      return res
        .status(openaiResponse.status)
        .json({ error: errText || "Unable to create realtime session" });
    }

    const session = await openaiResponse.json();

    return res.json({
      transcriptId: sessionId,
      model: MODEL,
      instructions,
      profileName: child.name || "Kiddo",
      session,
    });
  } catch (error) {
    console.error("Failed to create realtime session", error);
    return res.status(500).json({ error: "Realtime session creation failed" });
  }
});

/**
 * Append transcript entries to the server-side log file.
 */
app.post("/api/transcript", async (req, res) => {
  const { transcriptId, entries } = req.body || {};
  if (!transcriptId || !Array.isArray(entries)) {
    return res
      .status(400)
      .json({ error: "transcriptId and entries are required" });
  }

  try {
    await transcriptLogger.appendEntries(transcriptId, entries);
    return res.json({ ok: true });
  } catch (error) {
    console.error("Transcript append failed", error);
    return res.status(500).json({ error: "Could not write transcript" });
  }
});

// Fallback to index.html for unknown routes (simple SPA support)
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Santa hotline running on http://localhost:${PORT}`);
});

function buildSantaInstructions(child = {}) {
  const parts = [
    "You are Santa Claus on a cozy Christmas Eve phone call.",
    "Be warm, playful, and brief. Use lots of cheerful energy but keep answers concise for a real call cadence.",
    "Sound like old Saint Nick: deep, warm baritone with a hint of age and gentle gravel. Keep a steady pace with short, friendly sentences.",
    "Sprinkle in sound effects with your voice (bells, sleigh, elves cheering) when it feels fun.",
    summarizeProfile(child),
    child.name ? `You are talking to ${child.name}.` : null,
    child.age ? `They are ${child.age} years old.` : null,
    child.pronouns ? `Use pronouns: ${child.pronouns}.` : null,
    child.wishlist
      ? `Wishlist (mention naturally): ${child.wishlist}.`
      : null,
    child.favorites
      ? `Favorites to weave into the chat: ${child.favorites}.`
      : null,
    child.wins
      ? `Recent wins to celebrate: ${child.wins}.`
      : null,
    child.notes
      ? `Parent notes and boundaries: ${child.notes}.`
      : null,
    "Do not mention the current date or day. Just greet warmly without referencing the calendar.",
    "Keep the call in English. Only switch to Spanish if the caller explicitly asks you to (for example: \"please talk in Spanish too\").",
    "Keep the magic alive and avoid any sensitive or scary topics.",
  ].filter(Boolean);

  return parts.join(" ");
}

function summarizeProfile(child = {}) {
  const parts = [];
  if (child.name) parts.push(`Name: ${child.name}`);
  if (child.age) parts.push(`Age: ${child.age}`);
  if (child.pronouns) parts.push(`Pronouns: ${child.pronouns}`);
  if (child.favorites) parts.push(`Favorites: ${child.favorites}`);
  if (child.wishlist) parts.push(`Wishlist: ${child.wishlist}`);
  if (child.wins) parts.push(`Wins: ${child.wins}`);
  if (child.notes) parts.push(`Notes: ${child.notes}`);
  if (!parts.length) return "No profile details were provided.";
  return `Use these profile details without asking the parent: ${parts.join(
    "; "
  )}.`;
}

async function loadChildProfile(filePath) {
  const profile = {};
  try {
    const raw = await fs.promises.readFile(filePath, "utf8");
    raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .forEach((line) => {
        const match = line.match(/^([^:]+):\s*(.+)$/);
        if (!match) return;
        const key = match[1].toLowerCase();
        const value = match[2].trim();
        switch (key) {
          case "name":
            profile.name = value;
            break;
          case "age":
            profile.age = value;
            break;
          case "pronouns":
            profile.pronouns = value;
            break;
          case "wishlist":
            profile.wishlist = value;
            break;
          case "favorites":
            profile.favorites = value;
            break;
          case "wins":
            profile.wins = value;
            break;
          case "notes":
            profile.notes = value;
            break;
          default:
            break;
        }
      });
  } catch (error) {
    console.warn(
      `Child profile file not found or unreadable at ${filePath}; using defaults. Error: ${error.message}`
    );
  }
  return profile;
}

function ensureChildProfileFile(filePath) {
  try {
    if (fs.existsSync(filePath)) return;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const template = [
      "Name: Ava",
      "Age: 7",
      "Pronouns: she/her",
      "Favorites: penguins, glitter slime, baking cookies",
      "Wishlist: sparkly bike, illustrated storybooks, craft kits",
      "Wins: learned to tie shoes, shared toys with cousins",
      "Notes: keep it cozy, avoid surprises for mom, bedtime is soon",
    ].join("\n");
    fs.writeFileSync(filePath, template, "utf8");
    console.log(`Created child profile template at ${filePath}`);
  } catch (error) {
    console.error(`Unable to create child profile at ${filePath}`, error);
  }
}

async function saveChildProfile(filePath, child = {}) {
  const lines = [
    child.name ? `Name: ${child.name}` : null,
    child.age ? `Age: ${child.age}` : null,
    child.pronouns ? `Pronouns: ${child.pronouns}` : null,
    child.favorites ? `Favorites: ${child.favorites}` : null,
    child.wishlist ? `Wishlist: ${child.wishlist}` : null,
    child.wins ? `Wins: ${child.wins}` : null,
    child.notes ? `Notes: ${child.notes}` : null,
  ].filter(Boolean);

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, lines.join("\n") + "\n", "utf8");
}
