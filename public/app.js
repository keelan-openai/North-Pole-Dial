const callAction = document.getElementById("call-action");
const hangupBtn = document.getElementById("hangup");
const statusEl = document.querySelector("[data-status]");
const callStatusEl = document.querySelector("[data-call-status]");
const connectionStateEl = document.getElementById("connection-state");
const formEl = document.getElementById("child-form");
const profileToggle = document.getElementById("profile-toggle");
const profileBody = document.getElementById("profile-body");
const clearProfileBtn = document.getElementById("clear-profile");
const childListEl = document.getElementById("child-list");
const addChildBtn = document.getElementById("add-child");
const summaryEl = document.getElementById("transcript-summary");
const audioEl = document.getElementById("santa-audio");

// Shared voice selection for the session and greeting (must match supported list)
const VOICE = "cedar";
const TURN_REFRESH_INTERVAL = 4; // resend persona prompt every N turns
const IDLE_PROMPT_MS = 20000;
const DEBUG_TRANSCRIPT = false;
const SUMMARY_MODEL = "gpt-5-nano"; // overridable via server SUMMARY_MODEL env

const state = {
  childName: "Kiddo",
  childProfile: {},
  transcriptId: null,
  instructions: "",
  personaPrompt: "",
  modelSummary: "",
  connecting: false,
  connected: false,
  pendingUserTranscript: "",
  pendingSantaTranscript: "",
  completedTurns: 0,
  transcriptHistory: {
    user: [],
    santa: [],
  },
  transcriptLog: [],
  idleTimer: null,
  pc: null,
  dc: null,
  micStream: null,
  model: null,
};

function setStatus(text) {
  if (statusEl) statusEl.textContent = text;
  if (callStatusEl) callStatusEl.textContent = text;
}

function setConnection(text) {
  if (connectionStateEl) connectionStateEl.textContent = text;
}

function readChildProfileForm() {
  if (!formEl) return {};
  const formData = new FormData(formEl);
  const profile = {
    name: formData.get("name")?.trim() || "",
    age: formData.get("age")?.trim() || "",
    pronouns: formData.get("pronouns")?.trim() || "",
    favorites: formData.get("favorites")?.trim() || "",
    wishlist: formData.get("wishlist")?.trim() || "",
    wins: formData.get("wins")?.trim() || "",
    notes: formData.get("notes")?.trim() || "",
  };
  profile.children = readChildren();
  return profile;
}

function setChildProfileForm(profile = {}) {
  if (!formEl) return;
  formEl.name.value = profile.name || "";
  formEl.age.value = profile.age || "";
  formEl.pronouns.value = profile.pronouns || "";
  formEl.favorites.value = profile.favorites || "";
  formEl.wishlist.value = profile.wishlist || "";
  formEl.wins.value = profile.wins || "";
  formEl.notes.value = profile.notes || "";
  hydrateChildren(profile.children || []);
}

function persistProfile(profile) {
  try {
    localStorage.setItem("santa-profile", JSON.stringify(profile));
  } catch (_error) {
    // ignore storage issues
  }
}

function restoreProfile() {
  try {
    const raw = localStorage.getItem("santa-profile");
    if (!raw) return;
    const profile = JSON.parse(raw);
    state.childProfile = profile || {};
    state.childName = profile?.name || "Kiddo";
    setChildProfileForm(profile);
  } catch (_error) {
    // ignore storage issues
  }
}

function updateButtons({ connecting = false, connected = false } = {}) {
  if (callAction) callAction.disabled = connecting || connected;
  if (hangupBtn) hangupBtn.disabled = !connected;
}

if (profileToggle && profileBody) {
  profileToggle.addEventListener("click", () => {
    const isHidden = profileBody.hasAttribute("hidden");
    if (isHidden) {
      profileBody.removeAttribute("hidden");
      profileToggle.textContent = "Hide form";
    } else {
      profileBody.setAttribute("hidden", "true");
      profileToggle.textContent = "Show form";
    }
  });
}

if (formEl) {
  formEl.addEventListener("submit", (event) => {
    event.preventDefault();
    const profile = readChildProfileForm();
    state.childProfile = profile;
    state.childName = profile.name || "Kiddo";
    persistProfile(profile);
    setStatus("Profile saved for Santa");
  });
}

if (clearProfileBtn) {
  clearProfileBtn.addEventListener("click", () => {
    const empty = { children: [] };
    state.childProfile = empty;
    state.childName = "Kiddo";
    persistProfile(empty);
    setChildProfileForm(empty);
    setStatus("Profile cleared");
  });
}

if (addChildBtn && childListEl) {
  addChildBtn.addEventListener("click", () => {
    addChildRow();
  });
}

if (callAction) {
  callAction.addEventListener("click", () => startCall());
}
if (hangupBtn) {
  hangupBtn.addEventListener("click", () => endCall("Call ended"));
}

async function startCall() {
  if (state.connecting || state.connected) {
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("Mic access is required");
    alert("Microphone access is required to call Santa.");
    return;
  }

  state.connecting = true;
  setStatus("Dialing the North Pole...");
  setConnection("Connecting");
  if (callAction) callAction.textContent = "Connecting...";
  updateButtons({ connecting: true });
  if (formEl) {
    const profile = readChildProfileForm();
    state.childProfile = profile;
    state.childName = profile.name || "Kiddo";
    persistProfile(profile);
  }

  try {
    const sessionResponse = await fetch("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ child: state.childProfile }),
    });

    if (!sessionResponse.ok) {
      throw new Error(await sessionResponse.text());
    }

    const data = await sessionResponse.json();
    const clientSecret = data?.session?.client_secret?.value || data?.session?.client_secret;
    if (!clientSecret) {
      throw new Error("Missing realtime client secret");
    }

    state.instructions = data.instructions;
    state.personaPrompt = data.instructions || "";
    state.transcriptId = data.transcriptId;
    state.model = data.model;
    state.childName = data.profileName || "Kiddo";
    state.modelSummary = "";
    state.transcriptHistory = { user: [], santa: [] };
    state.transcriptLog = [];
    updateSummary();
    updateTranscriptLog();

    await openRealtimeConnection(clientSecret, data.model);
    state.connected = true;
    setStatus("On the line with Santa");
    setConnection("Live");
    if (callAction) callAction.textContent = "Santa is on";
    updateButtons({ connected: true });
    resetIdleTimer();
  } catch (error) {
    console.error(error);
    setStatus("Could not connect to Santa");
    setConnection("Disconnected");
    alert("Unable to start the call. Check your console and API key.");
  } finally {
    state.connecting = false;
    if (!state.connected) {
      updateButtons({ connecting: false, connected: false });
      if (callAction) callAction.textContent = "Start Call";
    }
  }
}

async function openRealtimeConnection(clientSecret, model) {
  cleanupConnection();

  const pc = new RTCPeerConnection();
  state.pc = pc;

  pc.addEventListener("connectionstatechange", () => {
    if (["disconnected", "failed", "closed"].includes(pc.connectionState)) {
      endCall("Connection dropped");
    }
  });

  pc.addEventListener("track", (event) => {
    if (!audioEl.srcObject || audioEl.srcObject.id !== event.streams[0].id) {
      audioEl.srcObject = event.streams[0];
    }
  });

  pc.addEventListener("datachannel", (event) => {
    wireDataChannel(event.channel);
  });

  const outbound = pc.createDataChannel("oai-events");
  wireDataChannel(outbound);

  const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  micStream.getTracks().forEach((track) => pc.addTrack(track, micStream));
  state.micStream = micStream;

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitForIceGatheringComplete(pc);

  const answerResponse = await fetch(
    `https://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${clientSecret}`,
        "Content-Type": "application/sdp",
      },
      body: pc.localDescription?.sdp || "",
    }
  );

  if (!answerResponse.ok) {
    throw new Error(await answerResponse.text());
  }

  const answer = await answerResponse.text();
  await pc.setRemoteDescription({ type: "answer", sdp: answer });
}

function wireDataChannel(channel) {
  state.dc = channel;

  channel.addEventListener("open", () => {
    setStatus("Connected — Santa can hear you");
    sendSessionConfig();
    sendWarmGreeting();
    resetIdleTimer();
  });

  channel.addEventListener("message", (event) => {
    handleRealtimeEvent(event.data);
  });
}

function sendSessionConfig() {
  if (!state.dc || state.dc.readyState !== "open") return;

  const payload = {
    type: "session.update",
    session: {
      instructions: state.personaPrompt || state.instructions,
      voice: VOICE,
      input_audio_format: "pcm16",
      output_audio_format: "pcm16",
      turn_detection: { type: "server_vad", threshold: 0.5 },
      input_audio_transcription: { model: "gpt-4o-mini-transcribe" },
    },
  };

  state.dc.send(JSON.stringify(payload));
}

function sendWarmGreeting() {
  if (!state.dc || state.dc.readyState !== "open") return;
  const names = buildChildNamesList();
  const greeting = `Hello, this is Santa! Ho ho ho, ${names}! I can hear you loud and clear from the North Pole. Let's dive into what you'd love for Christmas.`;
  state.dc.send(
    JSON.stringify({
      type: "response.create",
      response: {
        modalities: ["text", "audio"],
        voice: VOICE,
        input_text: greeting,
      },
    })
  );
}

function handleRealtimeEvent(message) {
  try {
    const payload = JSON.parse(message);
    const { type } = payload;
    if (DEBUG_TRANSCRIPT) {
      console.debug("Realtime event", type, payload);
    }

    switch (type) {
      case "input_audio_buffer.transcript.delta": // alt spelling
      case "input_audio_buffer.transcription.delta": {
        state.pendingUserTranscript += normalizeFragment(payload.delta || payload.text);
        setStatus("Listening");
        resetIdleTimer();
        break;
      }
      case "input_audio_buffer.transcript.completed": // alt spelling
      case "input_audio_buffer.transcription.completed": {
        const line =
          payload.transcript || payload.text || state.pendingUserTranscript;
        if (line) {
          pushTranscript([{ speaker: state.childName || "Child", text: line }]);
          sendStyleNudge();
          state.transcriptHistory.user.push(line);
          addLogEntry(state.childName || "Child", line);
          updateSummary();
          updateTranscriptLog();
        }
        state.pendingUserTranscript = "";
        setStatus("Santa is thinking");
        resetIdleTimer();
        break;
      }
      case "response.output_text.delta":
      case "response.text.delta": {
        const delta = normalizeFragment(payload.delta || payload.text);
        if (delta) {
          state.pendingSantaTranscript += delta;
          setStatus("Santa is speaking");
        }
        break;
      }
      case "response.text.done":
      case "response.text.completed":
      case "response.output_text.done":
      case "response.output_text.completed":
      case "response.completed": {
        finalizeSantaTranscript();
        state.completedTurns += 1;
        if (state.completedTurns % TURN_REFRESH_INTERVAL === 0) {
          sendSessionConfig();
        }
        setStatus("Listening");
        resetIdleTimer();
        break;
      }
      case "response.error": {
        setStatus("Santa hit a bump — check console");
        console.error("Realtime error", payload);
        break;
      }
      default:
        // If the event carries text/transcript, try to use it as a fallback
        if (payload) {
          const text = normalizeFragment(payload.transcript || payload.text || payload.delta);
          if (text) {
            if (String(type || "").includes("input_audio_buffer")) {
              state.transcriptHistory.user.push(text);
              addLogEntry(state.childName || "Child", text);
              state.pendingUserTranscript = "";
              setStatus("Santa is thinking");
              updateSummary();
            } else if (String(type || "").includes("response")) {
              state.pendingSantaTranscript += text;
            }
          }
        }
        break;
    }
    updateTranscriptLog();
  } catch (error) {
    console.debug("Non-JSON realtime message", message);
  }
}

function sendStyleNudge() {
  if (!state.dc || state.dc.readyState !== "open") return;
  const payload = {
    type: "response.create",
    response: {
      instructions: "Stay in character and keep the accent.",
    },
  };
  state.dc.send(JSON.stringify(payload));
}

function buildChildNamesList() {
  const names = [];
  if (state.childName) names.push(state.childName);
  const siblings = state.childProfile?.children || [];
  siblings.forEach((c) => {
    if (c.name) names.push(c.name);
  });
  if (!names.length) return "there";
  if (names.length === 1) return names[0];
  const last = names.pop();
  return `${names.join(", ")} and ${last}`;
}

function addChildRow(data = {}) {
  if (!childListEl) return;
  const row = document.createElement("div");
  row.className = "child-row";
  row.setAttribute("data-child-row", "true");

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.name = "child-name";
  nameInput.placeholder = "Sibling name";
  nameInput.value = data.name || "";

  const pronounsInput = document.createElement("input");
  pronounsInput.type = "text";
  pronounsInput.name = "child-pronouns";
  pronounsInput.placeholder = "they/them";
  pronounsInput.value = data.pronouns || "";

  const ageInput = document.createElement("input");
  ageInput.type = "number";
  ageInput.name = "child-age";
  ageInput.min = "0";
  ageInput.max = "18";
  ageInput.placeholder = "Age";
  ageInput.value = data.age || "";

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "ghost small remove-child";
  removeBtn.textContent = "Remove";
  removeBtn.addEventListener("click", () => {
    row.remove();
  });

  row.appendChild(nameInput);
  row.appendChild(pronounsInput);
  row.appendChild(ageInput);
  row.appendChild(removeBtn);
  childListEl.appendChild(row);
}

function hydrateChildren(children = []) {
  if (!childListEl) return;
  const rows = Array.from(childListEl.querySelectorAll("[data-child-row]"));
  rows.forEach((row, idx) => {
    if (idx > 0) row.remove();
  });
  const firstRow = childListEl.querySelector("[data-child-row]");
  if (firstRow) {
    const nameInput = firstRow.querySelector('input[name="child-name"]');
    const pronounsInput = firstRow.querySelector('input[name="child-pronouns"]');
    const ageInput = firstRow.querySelector('input[name="child-age"]');
    if (nameInput) nameInput.value = children[0]?.name || "";
    if (pronounsInput) pronounsInput.value = children[0]?.pronouns || "";
    if (ageInput) ageInput.value = children[0]?.age || "";
  }
  for (let i = 1; i < children.length; i++) {
    addChildRow(children[i]);
  }
}

function readChildren() {
  if (!childListEl) return [];
  const rows = Array.from(childListEl.querySelectorAll("[data-child-row]"));
  return rows
    .map((row) => {
      const name = row.querySelector('input[name="child-name"]')?.value.trim() || "";
      const pronouns = row.querySelector('input[name="child-pronouns"]')?.value.trim() || "";
      const age = row.querySelector('input[name="child-age"]')?.value.trim() || "";
      if (!name && !age && !pronouns) return null;
      return { name, age, pronouns };
    })
    .filter(Boolean);
}

function updateSummary() {
  if (!summaryEl) return;
  if (state.modelSummary) {
    summaryEl.textContent = state.modelSummary;
    return;
  }
  const kidLines = state.transcriptHistory.user || [];
  const santaLines = state.transcriptHistory.santa || [];
  if (!kidLines.length && !santaLines.length) {
    summaryEl.textContent = "No call yet. A short summary will appear here after you chat.";
    return;
  }

  const recentKid = kidLines.slice(-5).join(" ").trim();
  const wishlist = kidLines
    .filter((t) => /wish|want|would like|list|gift|ask/i.test(t))
    .slice(-3);

  let summary = recentKid
    ? `Kids said: ${recentKid.slice(0, 220)}${recentKid.length > 220 ? "..." : ""}`
    : "";

  if (wishlist.length) {
    summary += `${summary ? " | " : ""}Wishlist: ${wishlist.join(" / ")}`;
  }

  if (!summary && santaLines.length) {
    const recentSanta = santaLines.slice(-2).join(" ");
    summary = `Santa response highlights: ${recentSanta.slice(0, 220)}${recentSanta.length > 220 ? "..." : ""}`;
  }

  summaryEl.textContent = summary || "Summary pending...";
}

function updateTranscriptLog() {
  const logEl = document.getElementById("transcript-log");
  if (!logEl) return;
  if (!state.transcriptLog.length && !state.pendingUserTranscript && !state.pendingSantaTranscript) {
    logEl.textContent = "No conversation yet.";
    return;
  }
  const temp = [...state.transcriptLog];
  if (state.pendingUserTranscript) {
    temp.push({ speaker: state.childName || "Child", text: state.pendingUserTranscript });
  }
  if (state.pendingSantaTranscript) {
    temp.push({ speaker: "Santa", text: state.pendingSantaTranscript });
  }
  const recent = temp.slice(-12);
  const lines = recent
    .map(
      (item) =>
        `<div class="turn"><strong>${escapeHtml(item.speaker)}:</strong> ${escapeHtml(
          item.text
        )}</div>`
    )
    .join("");
  logEl.innerHTML = lines;
}

function finalizeSantaTranscript() {
  const text = state.pendingSantaTranscript?.trim();
  if (!text) {
    state.pendingSantaTranscript = "";
    return;
  }
  pushTranscript([{ speaker: "Santa", text }]);
  state.transcriptHistory.santa.push(text);
  addLogEntry("Santa", text);
  state.pendingSantaTranscript = "";
  updateSummary();
  updateTranscriptLog();
}

function addLogEntry(speaker, text) {
  if (!text) return;
  const normalized = text.trim();
  if (!normalized) return;
  const last = state.transcriptLog[state.transcriptLog.length - 1];
  if (last && last.speaker === speaker && last.text.trim() === normalized) return;
  state.transcriptLog.push({ speaker, text: normalized });
}

function escapeHtml(str = "") {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function summarizeConversation() {
  if (!state.transcriptLog.length) return;
  setSummary("Summarizing your call...");
  try {
    const response = await fetch("/api/summarize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        turns: state.transcriptLog,
        model: SUMMARY_MODEL,
      }),
    });
    if (!response.ok) throw new Error(await response.text());
    const data = await response.json();
    if (data.summary) {
      state.modelSummary = data.summary.trim();
      updateSummary();
      return;
    }
    throw new Error("No summary returned");
  } catch (error) {
    console.error("Summary failed", error);
    setSummary("Summary unavailable right now.");
  }
}

function setSummary(text) {
  if (!summaryEl) return;
  summaryEl.textContent = text;
}

function resetIdleTimer() {
  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
  }
  if (!state.connected || !state.dc || state.dc.readyState !== "open") return;
  state.idleTimer = setTimeout(() => {
    promptIdle();
  }, IDLE_PROMPT_MS);
}

function promptIdle() {
  if (!state.dc || state.dc.readyState !== "open") return;
  const payload = {
    type: "response.create",
    response: {
      modalities: ["text", "audio"],
      voice: VOICE,
      input_text:
        "I haven't heard you for a bit. Would you like a quick fun story or a silly Santa joke?",
    },
  };
  state.dc.send(JSON.stringify(payload));
  resetIdleTimer();
}
function normalizeFragment(delta) {
  if (!delta) return "";
  return typeof delta === "string" ? delta : "";
}

async function pushTranscript(entries) {
  if (!state.transcriptId) return;

  try {
    await fetch("/api/transcript", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcriptId: state.transcriptId, entries }),
    });
  } catch (error) {
    console.error("Failed to log transcript", error);
  }
}

function endCall(reason = "") {
  const flush = [];
  if (state.pendingUserTranscript) {
    const text = state.pendingUserTranscript;
    flush.push({ speaker: state.childName || "Child", text });
    state.transcriptHistory.user.push(text);
    addLogEntry(state.childName || "Child", text);
    state.pendingUserTranscript = "";
  }
  if (state.pendingSantaTranscript) {
    const text = state.pendingSantaTranscript;
    flush.push({ speaker: "Santa", text });
    state.transcriptHistory.santa.push(text);
    addLogEntry("Santa", text);
    state.pendingSantaTranscript = "";
  }
  if (flush.length) {
    pushTranscript(flush);
  }
  cleanupConnection();
  state.connected = false;
  setStatus(reason || "Call ended");
  setConnection("Disconnected");
  if (callAction) callAction.textContent = "Start Call";
  updateButtons({ connected: false });
  updateSummary();
  updateTranscriptLog();
  if (state.transcriptLog.length) {
    summarizeConversation();
  }
}

function cleanupConnection() {
  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
  }
  if (state.dc) {
    try {
      state.dc.close();
    } catch (_) {}
    state.dc = null;
  }
  if (state.pc) {
    try {
      state.pc.close();
    } catch (_) {}
    state.pc = null;
  }
  if (state.micStream) {
    state.micStream.getTracks().forEach((track) => track.stop());
    state.micStream = null;
  }
}

function waitForIceGatheringComplete(pc) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") {
      resolve();
    } else {
      const checkState = () => {
        if (pc.iceGatheringState === "complete") {
          pc.removeEventListener("icegatheringstatechange", checkState);
          resolve();
        }
      };
      pc.addEventListener("icegatheringstatechange", checkState);
    }
  });
}

updateButtons({ connected: false, connecting: false });
restoreProfile();
hydrateChildren(state.childProfile.children || []);
updateTranscriptLog();
