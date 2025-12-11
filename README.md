# Santa Hotline (OpenAI Realtime)

Festive voice call experience that connects a browser directly to the OpenAI Realtime API over WebRTC. Update a private text file with your child's details, press call, and Santa greets her with a warm, custom conversation. The UI keeps the magic on screen while every utterance is saved quietly to a text file for you to review later.

## What’s included
- Express server that serves the static client, issues short-lived Realtime client tokens, and saves transcripts to `data/transcripts/`.
- WebRTC client that streams mic audio to the Realtime API, receives Santa’s voice as a remote track, and listens to Realtime data-channel events for transcripts.
- Transcript logger: no transcript is shown in the UI; it is appended to a timestamped text file per call with basic metadata about your child.
- Festive single-page UI with a Santa call screen. Child details are read from `data/child-profile.txt` (never shown in the app).

## Quick start
1. Install dependencies
   ```bash
   cd santa-call-app
   npm install
   ```
2. Copy environment and set your key
   ```bash
   cp .env.example .env
   # fill in OPENAI_API_KEY=sk-...
   ```
3. (Optional) Edit Santa's private briefing file  
   Update `data/child-profile.txt` with your child's details. This file stays on disk and is read only by the server.

4. Run the server
   ```bash
   npm run dev
   # open http://localhost:3000
   ```

## Env vars
- `OPENAI_API_KEY` – required; used only on the server to mint client secrets.
- `PORT` – defaults to `3000`.
- `MODEL` – defaults to `gpt-4o-realtime-preview-2024-12-17`.
- `SANTA_VOICE` – voice name for output (defaults to `echo`).
- `TRANSCRIPT_DIR` – where transcript `.txt` files are written (defaults to `./data/transcripts`).

## How it works
- **Token minting:** `POST /api/session` calls `https://api.openai.com/v1/realtime/sessions` with your key to create an ephemeral `client_secret`. It loads the child details from `data/child-profile.txt`, opens a transcript file, and returns the Santa instruction string to the browser.
- **Realtime call:** The browser creates an `RTCPeerConnection`, sends its offer (mic track + data channel) to OpenAI with the `client_secret`, and receives an answer. Audio comes back as a remote track; Realtime events arrive on the data channel.
- **Session setup:** Once the data channel opens, the client sends `session.update` with persona instructions, VAD, and transcription settings, then sends a tiny greeting request so Santa starts the conversation.
- **Transcripts:** Realtime events `input_audio_buffer.transcription.completed` (child) and `response.completed` (Santa) are pushed to `/api/transcript`, which appends lines like `[timestamp] Santa: ...` to `data/transcripts/santa-call-<uuid>.txt`. Nothing is rendered on screen.

## Notes & next steps
- The greeting uses `response.create` with `input_text`; adjust in `public/app.js` if you prefer to let the child speak first.
- The Realtime API evolves quickly—if event names change, update the handlers in `handleRealtimeEvent` to match.
- Add auth if you deploy publicly; this scaffold is intentionally simple for local use.
- For a higher-fidelity “call feel,” layer in subtle call sounds or integrate a background score.
