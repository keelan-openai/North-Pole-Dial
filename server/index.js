require("dotenv").config();
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const { createTranscriptLogger } = require("./transcriptLogger");

const app = express();
const PORT = process.env.PORT || 3000;
const MODEL =
  process.env.MODEL || "gpt-realtime";
// Default summary model can be overridden via SUMMARY_MODEL env
const SUMMARY_MODEL = process.env.SUMMARY_MODEL || "gpt-5-nano";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VOICE = process.env.SANTA_VOICE || "cedar";
const DEFAULT_TRANSCRIPT_DIR = process.env.VERCEL
  ? path.join("/tmp", "transcripts")
  : path.join("data", "transcripts");
const TRANSCRIPT_DIR =
  process.env.TRANSCRIPT_DIR || DEFAULT_TRANSCRIPT_DIR;

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

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
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

  const child = req.body?.child || {};
  console.log("Loaded child profile", { child, source: "request" });
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

/**
 * Summarize a completed conversation using a lightweight model.
 */
app.post("/api/summarize", async (req, res) => {
  if (!OPENAI_API_KEY) {
    return res
      .status(500)
      .json({ error: "OPENAI_API_KEY missing from environment." });
  }

  const turns = Array.isArray(req.body?.turns) ? req.body.turns : [];
  const model = req.body?.model || SUMMARY_MODEL;

  if (!turns.length) {
    return res.status(400).json({ error: "No turns provided for summary." });
  }

  const conversation = turns
    .map((t) => `${t.speaker || "Unknown"}: ${t.text || ""}`.trim())
    .join("\n");

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content:
              "You are Santa's note-taker. Write a concise, parent-friendly call summary in 2-3 sentences. Include kids' names/pronouns/ages if present, key wishlist items, favorites, wins, and any boundaries or redirections Santa gave. Do not promise gifts. Keep it under 80 words.",
          },
          {
            role: "user",
            content: `Conversation transcript:\n${conversation}\n\nReturn only the summary text.`,
          },
        ],
        temperature: 0.4,
        max_tokens: 160,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ error: errText || "Summary failed" });
    }

    const data = await response.json();
    const summary =
      data?.choices?.[0]?.message?.content?.trim() || "Summary unavailable right now.";
    return res.json({ summary });
  } catch (error) {
    console.error("Summary generation failed", error);
    return res.status(500).json({ error: "Could not generate summary" });
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
    "Sound like an older Saint Nick: deep, warm baritone with audible age and gentle gravel. Keep a steady pace with short, friendly sentences.",
    "Sprinkle in sound effects with your voice (bells, sleigh, elves cheering) when it feels fun.",
    "Ask curious, gentle questions throughout: what they would like for Christmas, their favorite things, what made them proud, and what they'd enjoy doing with family. Keep the back-and-forth lively.",
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
    child.children && child.children.length
      ? `Siblings: ${child.children
          .map(
            (c) =>
              `${c.name || "Unnamed"}${c.age ? ` (age ${c.age})` : ""}${
                c.pronouns ? `, pronouns ${c.pronouns}` : ""
              }`
          )
          .join("; ")}.`
      : null,
    child.children && child.children.length
      ? `Greet and include all children by name: ${[
          child.name,
          ...child.children.map((c) => c.name).filter(Boolean),
        ]
          .filter(Boolean)
          .join(", ")}.`
      : null,
    "If a child asks for something unreasonable or a live pet (kitten/puppy), gently redirect: explain that's a big responsibility and they should talk with their parents, then steer back to fun Christmas gifts or shared experiences.",
    "Never promise anything a parent could not realistically provide. Keep expectations grounded and kind.",
    "Do not say 'Merry Christmas Eve'. Use a general, timeless greeting instead.",
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
