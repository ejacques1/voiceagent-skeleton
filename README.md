# Voice Agent Skeleton

A deployable voice agent template hosted on Vercel. Clone this repo for each client, customize `config.json`, and deploy.

## Quick Start

1. Clone this repo
2. Edit `config.json` with the client's business info
3. Deploy to Vercel
4. Set environment variables in Vercel dashboard

## Environment Variables

| Variable | Service | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | Anthropic | Claude conversation logic |
| `OPENAI_API_KEY` | OpenAI | Text-to-speech for web widget |
| `TWILIO_ACCOUNT_SID` | Twilio | Phone call handling |
| `TWILIO_AUTH_TOKEN` | Twilio | Phone call authentication |
| `NOTIFICATION_EMAIL` | — | Where to send lead notifications |

## Architecture

- **Web channel**: Browser → Web Speech API (STT) → `/api/chat` → Claude → OpenAI TTS → Audio playback
- **Phone channel**: Customer calls → Twilio → `/api/twilio` → Claude → Twilio neural voice → Caller hears response

## Files

| File | Purpose |
|---|---|
| `config.json` | The only file you edit per client — all business data lives here |
| `index.html` | Standalone voice agent page (shareable link) |
| `widget.js` | Embeddable chat bubble (`<script src="...">`) |
| `api/chat.js` | Serverless function: Claude + OpenAI TTS |
| `api/twilio.js` | Serverless function: phone call handler |

## Embedding the Widget

Add this script tag to any website:

```html
<script src="https://your-project.vercel.app/widget.js"></script>
```

## Local Development

```bash
npm install
npx vercel dev
```

## Deployment

```bash
npx vercel --prod
```

Then set your Twilio webhook URL to `https://your-project.vercel.app/api/twilio`.
