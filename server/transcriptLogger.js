const fs = require("fs");
const path = require("path");

/**
 * Lightweight transcript writer that appends plain text lines to a
 * timestamped file per call. Files are created on-demand with a header
 * describing the child details.
 */
function createTranscriptLogger(baseDir) {
  fs.mkdirSync(baseDir, { recursive: true });

  const sessionPath = (sessionId) =>
    path.join(baseDir, `santa-call-${sessionId}.txt`);

  async function startSession(sessionId, childDetails = {}) {
    const file = sessionPath(sessionId);
    const lines = [
      `Santa Call started ${new Date().toISOString()}`,
      `Child: ${childDetails.name || "Unknown"}${
        childDetails.age ? ` (age ${childDetails.age})` : ""
      }`,
      childDetails.pronouns
        ? `Pronouns: ${childDetails.pronouns}`
        : "Pronouns: n/a",
      childDetails.wishlist ? `Wishlist: ${childDetails.wishlist}` : null,
      childDetails.wins ? `Recent wins: ${childDetails.wins}` : null,
      childDetails.favorites
        ? `Favorites: ${childDetails.favorites}`
        : null,
      childDetails.notes ? `Notes: ${childDetails.notes}` : null,
      "---",
    ].filter(Boolean);

    await fs.promises.writeFile(file, lines.join("\n") + "\n", "utf8");
    return file;
  }

  async function appendEntries(sessionId, entries = []) {
    const file = sessionPath(sessionId);
    const timestamp = new Date().toISOString();
    const payload = entries
      .filter((item) => item && item.text)
      .map(
        (item) =>
          `[${timestamp}] ${item.speaker || "Unknown"}: ${item.text.trim()}\n`
      )
      .join("");
    if (!payload) return;
    await fs.promises.appendFile(file, payload, "utf8");
  }

  return {
    startSession,
    appendEntries,
  };
}

module.exports = { createTranscriptLogger };
