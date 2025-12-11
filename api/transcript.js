const path = require("path");
const { createTranscriptLogger } = require("../server/transcriptLogger");
require("dotenv").config();

const DEFAULT_TRANSCRIPT_DIR = process.env.VERCEL
  ? path.join("/tmp", "transcripts")
  : path.join(process.cwd(), "data", "transcripts");
const TRANSCRIPT_DIR = process.env.TRANSCRIPT_DIR || DEFAULT_TRANSCRIPT_DIR;

const transcriptLogger = createTranscriptLogger(TRANSCRIPT_DIR);

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  let body = {};
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  } catch (_err) {
    body = {};
  }

  const { transcriptId, entries } = body;
  if (!transcriptId || !Array.isArray(entries)) {
    return res
      .status(400)
      .json({ error: "transcriptId and entries are required" });
  }

  try {
    await transcriptLogger.appendEntries(transcriptId, entries);
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Transcript append failed", error);
    return res.status(500).json({ error: "Could not write transcript" });
  }
};
