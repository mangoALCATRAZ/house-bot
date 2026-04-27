# 🤖 house-bot

A Cloudflare Workers-powered Discord bot for household automation. Tracks the dishwasher, laundry, and who's home — triggered via Apple Shortcuts and NFC tags. Features a shared calendar with Discord slash commands and automatic daily cleanup of old messages.

---

## Features

- 🍽️ **Dishwasher alerts** — Notifies when the dishwasher is running, done, and ready to unload
- 👕 **Laundry alerts** — Tracks washer and dryer cycles with timed notifications
- 🏠 **Leave/Arrival alerts** — Notifies when someone leaves or arrives home with live location support and reverse geocoding via Google Maps
- 📅 **Calendar** — Shared house calendar with Discord slash commands (`/event`, `/cancel`, `/events`) and timed reminders
- 🧹 **Auto-cleanup** — Deletes messages older than 7 days from alert channels every night at 3 AM EST, preserving pinned messages
- 📌 **Pinned status boards** — Persistent pinned messages in each channel showing current state
- 🔔 **Auto-intro messages** — Each channel gets a pinned welcome message on first use
- 🧪 **Dev mode** — Redirect all messages to a spam channel with `?dev=1` for safe testing
- ⏱️ **Precise timing** — Uses Cloudflare Durable Objects with alarms for exact notification timing

---

## Architecture

```
Apple Shortcut / NFC Tag / MacroDroid (Android)
        │
        ▼
Cloudflare Worker (HTTP GET)
        │
        ├──▶ Discord REST API (messages, channel renames, pins)
        ├──▶ Cloudflare KV (state persistence)
        ├──▶ Cloudflare Durable Objects (timed alarms + daily cull)
        └──▶ Google Maps Geocoding API (reverse geocoding)

Discord Slash Commands (/event, /cancel, /events)
        │
        ▼
Cloudflare Worker (/interactions)
        │
        └──▶ Cloudflare KV + Durable Objects
```

---

## Setup

### Prerequisites

- [Cloudflare account](https://cloudflare.com) with Workers and KV enabled
- [Discord application and bot](https://discord.com/developers/applications)
- [Google Maps API key](https://console.cloud.google.com) with Geocoding API enabled
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) installed

### 1. Clone the repo

```bash
git clone https://github.com/mangoALCATRAZ/house-bot.git
cd house-bot
```

### 2. Configure `wrangler.toml`

```toml
name = "discord-shortcut"
main = "worker.js"
compatibility_date = "2025-04-26"

[[kv_namespaces]]
binding = "KV"
id = "YOUR_KV_NAMESPACE_ID"

[[durable_objects.bindings]]
name = "TIMER"
class_name = "TimerDO"

[[durable_objects.bindings]]
name = "CULLER"
class_name = "CullDO"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["TimerDO"]

[[migrations]]
tag = "v2"
new_sqlite_classes = ["CullDO"]
```

### 3. Set secrets

```bash
wrangler secret put DISCORD_TOKEN
wrangler secret put DISCORD_PUBLIC_KEY
wrangler secret put GOOGLE_MAPS_KEY
```

| Secret | Description |
|--------|-------------|
| `DISCORD_TOKEN` | Your Discord bot token (Bot → Reset Token in developer portal) |
| `DISCORD_PUBLIC_KEY` | Your app's public key (General Information in developer portal) |
| `GOOGLE_MAPS_KEY` | Google Maps API key with Geocoding API enabled |

### 4. Deploy

```bash
wrangler deploy
```

### 5. Register slash commands

Run these one-time curl commands. Replace `YOUR_APP_ID` and `YOUR_BOT_TOKEN`:

```bash
# /event
curl -X POST https://discord.com/api/v10/applications/YOUR_APP_ID/commands \
  -H "Authorization: Bot YOUR_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "event",
    "description": "Add a calendar event",
    "options": [
      {"name": "title", "description": "Event title", "type": 3, "required": true},
      {"name": "date", "description": "Date (YYYY-MM-DD)", "type": 3, "required": true},
      {"name": "time", "description": "Time in EST (HH:MM, 24h)", "type": 3, "required": true},
      {"name": "reminder", "description": "Reminder minutes before (default: 30)", "type": 4, "required": false}
    ]
  }'

# /cancel
curl -X POST https://discord.com/api/v10/applications/YOUR_APP_ID/commands \
  -H "Authorization: Bot YOUR_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "cancel", "description": "Cancel an event", "options": [{"name": "id", "description": "Event ID", "type": 3, "required": true}]}'

# /events
curl -X POST https://discord.com/api/v10/applications/YOUR_APP_ID/commands \
  -H "Authorization: Bot YOUR_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "events", "description": "List upcoming events"}'
```

### 6. Set Interactions Endpoint URL

In your Discord app's **General Information**, set the **Interactions Endpoint URL** to:

```
https://YOUR_WORKER_URL/interactions
```

### 7. Kick off the daily culler

Trigger any API endpoint once after deploying to start the `CullDO`:

```
https://YOUR_WORKER_URL/?token=TOKEN
```

---

## API Reference

**Base URL:** `https://YOUR_WORKER_URL`

All endpoints are HTTP GET requests and require `?token=TOKEN`.

Add `&dev=1` to any request to redirect all messages to `#bot-development-spam` for testing (pings suppressed, channel renames skipped).

---

### 🍽️ Dishwasher

#### `GET /`
Start a dishwasher cycle.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `minutes` | int | No | `150` | Estimated runtime in minutes |

```
GET /?token=TOKEN
GET /?token=TOKEN&minutes=90
```

#### `GET /unloaded`
Mark the dishwasher as empty and ready to load.

```
GET /unloaded?token=TOKEN
```

---

### 👕 Laundry

#### `GET /washer`
Start a washer cycle.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `minutes` | int | No | `45` | Estimated runtime in minutes |

```
GET /washer?token=TOKEN
GET /washer?token=TOKEN&minutes=60
```

#### `GET /dryer`
Start a dryer cycle. Automatically clears the washer done message.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `minutes` | int | No | `45` | Estimated runtime in minutes |

```
GET /dryer?token=TOKEN
GET /dryer?token=TOKEN&minutes=60
```

---

### 📅 Calendar

Calendar events are managed via Discord slash commands in `#calendar`. All times are in **EST**.

| Command | Description |
|---------|-------------|
| `/event title date time [reminder]` | Add an event. Date: `YYYY-MM-DD`, time: `HH:MM` 24h |
| `/cancel id` | Cancel an event by its ID |
| `/events` | List all upcoming events |

Event IDs are shown in the pinned calendar board and in the confirmation message when an event is created.

---

### 🏠 Leave/Arrival

#### `GET /arrived`
Mark someone as arrived home.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `person` | string | Yes | Person key (see supported people) |

```
GET /arrived?token=TOKEN&person=snake
```

#### `GET /left`
Mark someone as having left home.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `person` | string | Yes | Person key |
| `destination` | string | No | Where they went |

```
GET /left?token=TOKEN&person=snake
GET /left?token=TOKEN&person=snake&destination=Walmart
```

#### `GET /location`
Post a live location ping with a Google Maps link and reverse-geocoded place name.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `person` | string | Yes | Person key |
| `lat` | float | Yes | Latitude |
| `lon` | float | Yes | Longitude |

```
GET /location?token=TOKEN&person=snake&lat=39.9526&lon=-75.1652
```

---

## Supported People

| Key | Discord |
|-----|---------|
| `snake` | @Snake |
| `floogin` | @Floogin |
| `toad` | @LocalToad |

To add more people, update the `PEOPLE` object in `worker.js`:

```javascript
const PEOPLE = {
  "snake": "<@DISCORD_USER_ID>",
  "newperson": "<@ANOTHER_USER_ID>",
};
```

---

## Discord Channels

| Channel | Purpose |
|---------|---------|
| `#general` | Bot introduction post |
| `#dishwasher-alerts` | Dishwasher status updates |
| `#laundry-alerts` | Washer and dryer status updates |
| `#leave-arrival-alerts` | Who's home status board and location alerts |
| `#calendar` | Upcoming events board and slash command interface |
| `#bot-api-documentation` | Full API docs, auto-posted by the bot |
| `#bot-development-spam` | Dev mode message sink (`?dev=1`) |

---

## Auto-Cleanup

The `CullDO` Durable Object runs every night at **3 AM EST** and deletes messages older than 7 days from `#dishwasher-alerts`, `#laundry-alerts`, and `#leave-arrival-alerts`. Pinned messages are always preserved. `#calendar` is never culled.

---

## Dev Mode

Add `?dev=1` to any API request to redirect all messages to `#bot-development-spam`:

```
/?token=TOKEN&minutes=1&dev=1
```

- All messages route to the dev channel with a `[→ #original-channel]` prefix
- `@everyone` and `@here` pings are stripped
- Channel renames are skipped
- Timed followup messages (e.g. dishwasher done) also route to dev channel

---

## Android Setup (MacroDroid)

Install **MacroDroid** from the Play Store (free, up to 5 macros).

1. Open MacroDroid → **Add Macro**
2. **Trigger**: choose NFC Tag, Location (geofence), or Shortcut/Widget
3. **Action**: Connectivity → HTTP Request → Method: GET → paste URL
4. Save and name the macro

For geolocation triggers, use **Enter/Exit Area** with a 100–200m radius around the house.

---

## Bot Permissions

The bot requires the following permissions in each channel:
- **Send Messages**
- **Manage Messages** (for pinning and deletion)
- **Read Message History**

---

## Environment Variables

| Variable | Type | Description |
|----------|------|-------------|
| `DISCORD_TOKEN` | Secret | Discord bot token |
| `DISCORD_PUBLIC_KEY` | Secret | Discord app public key for interaction verification |
| `GOOGLE_MAPS_KEY` | Secret | Google Maps Geocoding API key |
| `KV` | KV Binding | Cloudflare KV namespace for state persistence |
| `TIMER` | DO Binding | Cloudflare Durable Object for timed alarms |
| `CULLER` | DO Binding | Cloudflare Durable Object for daily message cleanup |

---

## License

MIT
