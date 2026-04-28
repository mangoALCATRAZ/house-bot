import { DurableObject } from "cloudflare:workers";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// API auth token for HTTP endpoints (passed as ?token=TOKEN in requests)
const TOKEN = "VXHeXQe7dn2SGMSK5B";

// Discord channel IDs
const CHANNEL_ID = "1497845829938188339";           // #dishwasher-alerts
const LOCATION_CHANNEL_ID = "1498080106927886355";  // #leave-arrival-alerts
const DOCS_CHANNEL_ID = "1498080983570845816";      // #bot-api-documentation
const LAUNDRY_CHANNEL_ID = "1498166929343643790";   // #laundry-alerts
const GENERAL_CHANNEL_ID = "1497871726162350180";   // #general
const CALENDAR_CHANNEL_ID = "1498206238339760158";  // #calendar
const DEV_CHANNEL_ID = "1497815253311029381";       // #bot-development-spam

// Discord app/API config
const APP_ID = "1497846686624776363";               // Discord application ID
const API = "https://discord.com/api/v10";          // Discord REST API base URL
const TZ = "America/New_York";                      // Timezone for calendar and cull scheduling

// GitHub repo URL included in API docs
const GITHUB_URL = "https://github.com/mangoALCATRAZ/house-bot";

// When true, all messages are redirected to #bot-development-spam.
// Set per-request via ?dev=1 query param. Also stored in timer params
// so timed followup messages (e.g. "dishwasher done") also redirect.
let DEV_MODE = false;

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------
// Map of person keys (used in API params) to Discord mention strings.
// Add new housemates here. Keys are case-insensitive.
// Example: "peter": "<@123456789>"
const PEOPLE = {
  "snake": "<@436947323445313536>",
  "floogin": "<@209825795852599297>",
  "toad": "<@424005925859229696>",
};

// ---------------------------------------------------------------------------
// Cull config
// ---------------------------------------------------------------------------
// Channels to include in the nightly 3 AM message cull (excludes #calendar)
const CULL_CHANNELS = [CHANNEL_ID, LAUNDRY_CHANNEL_ID, LOCATION_CHANNEL_ID];

// Age threshold for nightly cull — messages older than this are deleted
const CULL_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// How long laundry "done" messages persist before being auto-deleted
const LAUNDRY_DONE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

// ---------------------------------------------------------------------------
// Discord API helpers
// ---------------------------------------------------------------------------

// Returns auth headers for bot API requests
function botHeaders(env) {
  return {
    "Authorization": `Bot ${env.DISCORD_TOKEN}`,
    "Content-Type": "application/json",
  };
}

// Posts a message to a Discord channel.
// In DEV_MODE, redirects to #bot-development-spam and strips @everyone/@here.
async function sendMessage(env, channelId, content) {
  const targetChannel = DEV_MODE ? DEV_CHANNEL_ID : channelId;
  let finalContent = DEV_MODE
    ? `[→ <#${channelId}>] ${content.replace(/@everyone/g, "").replace(/@here/g, "").trim()}`
    : content;
  const res = await fetch(`${API}/channels/${targetChannel}/messages`, {
    method: "POST",
    headers: botHeaders(env),
    body: JSON.stringify({ content: finalContent }),
  });
  return res.json();
}

// Edits an existing message. Skipped in DEV_MODE.
async function editMessage(env, channelId, msgId, content) {
  if (DEV_MODE) return;
  await fetch(`${API}/channels/${channelId}/messages/${msgId}`, {
    method: "PATCH",
    headers: botHeaders(env),
    body: JSON.stringify({ content }),
  });
}

// Deletes a message. Skipped in DEV_MODE.
async function deleteMessage(env, channelId, msgId) {
  if (DEV_MODE) return;
  await fetch(`${API}/channels/${channelId}/messages/${msgId}`, {
    method: "DELETE",
    headers: botHeaders(env),
  });
}

// Pins a message to a channel. Skipped in DEV_MODE.
async function pinMessage(env, channelId, msgId) {
  if (DEV_MODE) return;
  await fetch(`${API}/channels/${channelId}/pins/${msgId}`, {
    method: "PUT",
    headers: botHeaders(env),
  });
}

// Renames a channel with an emoji prefix, e.g. "🔴dishwasher-alerts".
// Handles rate limiting with a single retry. Skipped in DEV_MODE.
async function setChannelName(env, channelId, emoji, baseName) {
  if (DEV_MODE) return;
  const res = await fetch(`${API}/channels/${channelId}`, {
    method: "PATCH",
    headers: botHeaders(env),
    body: JSON.stringify({ name: `${emoji}${baseName}` }),
  });
  if (res.status === 429) {
    const data = await res.json();
    const retryAfter = data.retry_after * 1000;
    await new Promise(resolve => setTimeout(resolve, retryAfter));
    await fetch(`${API}/channels/${channelId}`, {
      method: "PATCH",
      headers: botHeaders(env),
      body: JSON.stringify({ name: `${emoji}${baseName}` }),
    });
  }
}

// ---------------------------------------------------------------------------
// Google Maps
// ---------------------------------------------------------------------------

// Converts GPS coordinates to a human-readable address using the
// Google Maps Geocoding API. Prefers named establishments over street addresses.
// Returns null if geocoding fails or no results are found.
async function reverseGeocode(env, lat, lon) {
  const res = await fetch(
    `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lon}&key=${env.GOOGLE_MAPS_KEY}`
  );
  const data = await res.json();
  if (data.status === "OK" && data.results.length > 0) {
    const place = data.results.find(r =>
      r.types.includes("establishment") || r.types.includes("point_of_interest")
    );
    if (place) return place.formatted_address;
    return data.results[0].formatted_address;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cull helpers
// ---------------------------------------------------------------------------

// Calculates the UTC timestamp for the next 3 AM EST/EDT occurrence.
// Used by CullDO to schedule its nightly alarm.
function getNext3AMEST() {
  const now = new Date();
  const estNow = new Date(now.toLocaleString("en-US", { timeZone: TZ }));
  const next3AM = new Date(estNow);
  next3AM.setHours(3, 0, 0, 0);
  if (estNow >= next3AM) next3AM.setDate(next3AM.getDate() + 1);
  const tzOffset =
    new Date(next3AM.toLocaleString("en-US", { timeZone: "UTC" })) -
    new Date(next3AM.toLocaleString("en-US", { timeZone: TZ }));
  return next3AM.getTime() + tzOffset;
}

// Fetches all pinned message IDs for a channel.
// Used by cullChannel to avoid deleting pinned intro/status messages.
async function getPinnedIds(env, channelId) {
  const res = await fetch(`${API}/channels/${channelId}/pins`, {
    headers: botHeaders(env),
  });
  const pins = await res.json();
  return Array.isArray(pins) ? pins.map(p => p.id) : [];
}

// Deletes all non-pinned messages older than CULL_AGE_MS from a channel.
// Paginates through messages in batches of 100, stopping when all remaining
// messages are newer than the cutoff. Rate-limited to 500ms between deletes.
async function cullChannel(env, channelId) {
  const pinnedIds = await getPinnedIds(env, channelId);
  const cutoff = Date.now() - CULL_AGE_MS;
  let lastId = null;
  let culled = 0;

  while (true) {
    const queryUrl = lastId
      ? `${API}/channels/${channelId}/messages?limit=100&before=${lastId}`
      : `${API}/channels/${channelId}/messages?limit=100`;

    const res = await fetch(queryUrl, { headers: botHeaders(env) });
    const messages = await res.json();

    if (!Array.isArray(messages) || messages.length === 0) break;

    for (const msg of messages) {
      // Extract timestamp from Discord snowflake ID
      const msgTs = Number(BigInt(msg.id) >> 22n) + 1420070400000;
      if (msgTs > cutoff) {
        lastId = msg.id;
        continue;
      }
      if (pinnedIds.includes(msg.id)) continue;
      await fetch(`${API}/channels/${channelId}/messages/${msg.id}`, {
        method: "DELETE",
        headers: botHeaders(env),
      });
      culled++;
      await new Promise(r => setTimeout(r, 500));
    }

    const oldest = messages[messages.length - 1];
    const oldestTs = Number(BigInt(oldest.id) >> 22n) + 1420070400000;
    if (oldestTs < cutoff) break;
    lastId = oldest.id;
  }

  return culled;
}

// ---------------------------------------------------------------------------
// Discord interaction signature verification
// ---------------------------------------------------------------------------

// Verifies that an incoming /interactions POST request is genuinely from Discord
// using Ed25519 signature verification. Returns the raw body string if valid,
// false if invalid. Required by Discord for all interaction endpoints.
async function verifyDiscordSignature(request, env) {
  const signature = request.headers.get("x-signature-ed25519");
  const timestamp = request.headers.get("x-signature-timestamp");
  if (!signature || !timestamp) return false;

  const body = await request.text();
  const key = await crypto.subtle.importKey(
    "raw",
    hexToBytes(env.DISCORD_PUBLIC_KEY),
    { name: "Ed25519", namedCurve: "Ed25519" },
    false,
    ["verify"]
  );
  const valid = await crypto.subtle.verify(
    { name: "Ed25519" },
    key,
    hexToBytes(signature),
    new TextEncoder().encode(timestamp + body)
  );
  return valid ? body : false;
}

// Converts a hex string to a Uint8Array, used for Ed25519 key/signature parsing.
function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Calendar helpers
// ---------------------------------------------------------------------------

// Parses a date (YYYY-MM-DD) and time (HH:MM) string in EST/EDT
// and returns a UTC Date object.
function parseEventTime(date, time) {
  const localDate = new Date(`${date}T${time}:00`);
  const tzOffset =
    new Date(localDate.toLocaleString("en-US", { timeZone: "UTC" })) -
    new Date(localDate.toLocaleString("en-US", { timeZone: TZ }));
  return new Date(localDate.getTime() + tzOffset);
}

// Retrieves the calendar event list from KV. Returns [] if none exist.
async function getEvents(env) {
  const raw = await env.KV.get("calendar_events");
  return raw ? JSON.parse(raw) : [];
}

// Saves the calendar event list to KV.
async function saveEvents(env, events) {
  await env.KV.put("calendar_events", JSON.stringify(events));
}

// Removes events whose timestamp has passed and saves the updated list.
// Returns the list of upcoming (non-expired) events.
async function pruneExpiredEvents(env) {
  const events = await getEvents(env);
  const now = Date.now();
  const upcoming = events.filter(e => e.ts > now);
  if (upcoming.length !== events.length) await saveEvents(env, upcoming);
  return upcoming;
}

// Builds the pinned calendar board message content showing all upcoming events,
// sorted by date. Shows event title, timestamp, reminder, and ID.
async function buildCalendarBoard(env) {
  const events = await pruneExpiredEvents(env);
  const lines = ["📅 **Upcoming Events**", "​"];

  if (events.length === 0) {
    lines.push("No upcoming events.");
  } else {
    const sorted = [...events].sort((a, b) => a.ts - b.ts);
    for (const e of sorted) {
      const ts = Math.floor(e.ts / 1000);
      lines.push(`📌 **${e.title}** — <t:${ts}:F> (<t:${ts}:R>)`);
      lines.push(`   🔔 Reminder: ${e.reminder} min before  |  🆔 \`${e.id}\``);
      lines.push("");
    }
  }

  lines.push("​");
  lines.push("​");
  return lines.join("\n");
}

// Edits the pinned calendar board message with the latest event list.
async function updateCalendarBoard(env) {
  const calMsgId = await env.KV.get("calendar_msg_id");
  const content = await buildCalendarBoard(env);
  if (calMsgId) await editMessage(env, CALENDAR_CHANNEL_ID, calMsgId, content);
}

// ---------------------------------------------------------------------------
// Slash command handlers
// ---------------------------------------------------------------------------

// Handles /event — validates input, stores event in KV, schedules reminder
// and expiry timers, updates the calendar board, and posts a confirmation.
async function handleEventCommand(env, options) {
  const title = options.find(o => o.name === "title")?.value;
  const date = options.find(o => o.name === "date")?.value;
  const time = options.find(o => o.name === "time")?.value;
  const reminder = options.find(o => o.name === "reminder")?.value ?? 30;

  if (!title || !date || !time) return "❌ Missing title, date, or time.";

  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  const timeRegex = /^\d{2}:\d{2}$/;
  if (!dateRegex.test(date)) return "❌ Date must be in YYYY-MM-DD format.";
  if (!timeRegex.test(time)) return "❌ Time must be in HH:MM format (24h EST).";

  const eventDate = parseEventTime(date, time);
  const eventTs = eventDate.getTime();
  const now = Date.now();

  if (eventTs <= now) return "❌ Event date is in the past.";

  await maybePostCalendarIntro(env);

  const id = `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const events = await getEvents(env);
  events.push({ id, title, ts: eventTs, reminder });
  await saveEvents(env, events);

  // Schedule reminder (fires X minutes before the event)
  const reminderDelay = eventTs - now - reminder * 60 * 1000;
  if (reminderDelay > 0) {
    await scheduleTimer(env, "event_reminder", reminderDelay, {
      eventId: id, eventTitle: title, eventTs,
    });
  }

  // Schedule expiry cleanup (fires 1 minute after event time)
  await scheduleTimer(env, "event_expire", eventTs - now + 60000, { eventId: id });
  await updateCalendarBoard(env);
  await sendMessage(env, CALENDAR_CHANNEL_ID, `@here 📅 New event added: **${title}** — <t:${Math.floor(eventTs / 1000)}:F> 🔔 Reminder ${reminder} min before. 🆔 \`${id}\``);

  return `✅ Event **${title}** added for <t:${Math.floor(eventTs / 1000)}:F>! ID: \`${id}\``;
}

// Handles /cancel — removes an event from KV by ID, updates the board,
// and posts a cancellation notice to #calendar.
async function handleCancelCommand(env, options) {
  const id = options.find(o => o.name === "id")?.value;
  if (!id) return "❌ Missing event ID.";

  const events = await getEvents(env);
  const idx = events.findIndex(e => e.id === id);
  if (idx === -1) return "❌ Event not found. Check the ID in the calendar.";

  const [removed] = events.splice(idx, 1);
  await saveEvents(env, events);
  await updateCalendarBoard(env);
  await sendMessage(env, CALENDAR_CHANNEL_ID, `@here ❌ Event cancelled: **${removed.title}** (<t:${Math.floor(removed.ts / 1000)}:F>)`);

  return `✅ Event **${removed.title}** cancelled.`;
}

// Handles /events — returns a formatted list of upcoming events as an
// ephemeral-style reply (only visible to the user who ran the command).
async function handleEventsCommand(env) {
  const events = await pruneExpiredEvents(env);
  if (events.length === 0) return "📅 No upcoming events.";

  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  const lines = ["📅 **Upcoming Events**", ""];
  for (const e of sorted) {
    const ts = Math.floor(e.ts / 1000);
    lines.push(`📌 **${e.title}** — <t:${ts}:F> (<t:${ts}:R>) 🆔 \`${e.id}\``);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Status board (#leave-arrival-alerts)
// ---------------------------------------------------------------------------

// Builds the pinned status board message content showing the current
// location/status of all people in PEOPLE. Shows home, out, or last seen.
async function buildStatusBoard(env) {
  const lines = ["📊 **Current Status**"];
  for (const key of Object.keys(PEOPLE)) {
    const raw = await env.KV.get(`status_${key}`);
    if (!raw) {
      lines.push(`❓ **${key}** — Unknown`);
      continue;
    }
    const status = JSON.parse(raw);
    const ts = `<t:${status.ts}:R>`;
    if (status.type === "arrived") {
      lines.push(`🏠 **${key}** — Home (${ts})`);
    } else if (status.type === "left") {
      const dest = status.destination ? ` — headed to ${status.destination}` : "";
      lines.push(`🚶 **${key}** — Out${dest} (${ts})`);
    } else if (status.type === "location") {
      const place = status.place ? ` (${status.place})` : "";
      lines.push(`🌐 **${key}** — Last seen [here](${status.mapsLink})${place} (${ts})`);
    }
  }
  lines.push("​");
  lines.push("​");
  return lines.join("\n");
}

// Edits the pinned status board message with the latest status for all people.
async function updateStatusBoard(env) {
  const statusMsgId = await env.KV.get("status_msg_id");
  const content = await buildStatusBoard(env);
  if (statusMsgId) await editMessage(env, LOCATION_CHANNEL_ID, statusMsgId, content);
}

// ---------------------------------------------------------------------------
// Channel intro posts
// All maybePost* functions check if the channel is empty before posting.
// They are idempotent — safe to call on every request.
// ---------------------------------------------------------------------------

// Posts the #general intro message and pins it. Only fires if #general is empty.
async function maybePostGeneral(env) {
  const res = await fetch(`${API}/channels/${GENERAL_CHANNEL_ID}/messages?limit=1`, {
    headers: botHeaders(env),
  });
  const messages = await res.json();
  if (messages.length === 0) {
    const data = await sendMessage(env, GENERAL_CHANNEL_ID, [
      "👋 **Hey everyone! I'm house-bot.**",
      "I help keep the house in sync by posting automatic alerts to dedicated channels. Here's what I track:",
      "​",
      "🍽️ **#dishwasher-alerts** — Notifies when the dishwasher is running, done, and ready to unload.",
      "👕 **#laundry-alerts** — Notifies when the washer and dryer are running and done.",
      "🏠 **#leave-arrival-alerts** — Notifies when someone leaves or arrives home, with live location support.",
      "📅 **#calendar** — Shared house calendar. Use `/event`, `/cancel`, and `/events` slash commands in #calendar.",
      "📖 **#bot-api-documentation** — Full API docs for triggering the bot via Shortcuts or NFC tags.",
      "​",
      "​",
    ].join("\n"));
    await pinMessage(env, GENERAL_CHANNEL_ID, data.id);
  }
}

// Posts the #dishwasher-alerts intro and pins it. Only fires if channel is empty.
async function maybePostIntro(env) {
  const res = await fetch(`${API}/channels/${CHANNEL_ID}/messages?limit=1`, {
    headers: botHeaders(env),
  });
  const messages = await res.json();
  if (messages.length === 0) {
    const data = await sendMessage(env, CHANNEL_ID, [
      "👋 **Welcome to #dishwasher-alerts!**",
      "This channel is automatically updated by a bot to track the state of the dishwasher. The bot is triggered via a Shortcut or NFC tag on the dishwasher itself.",
      "​",
      "**Status guide:**",
      "🔴 **Running** — The dishwasher is currently running. Don't open it!",
      "🏁 **Done** — The dishwasher has finished. Please unload it when you get a chance.",
      "🟩 **Empty** — The dishwasher is empty and ready to be loaded.",
      "​",
      "​",
    ].join("\n"));
    await pinMessage(env, CHANNEL_ID, data.id);
  }
}

// Posts the #leave-arrival-alerts intro and pins it, then posts and pins
// the initial status board. Only fires if channel is empty.
async function maybePostLocationIntro(env) {
  const res = await fetch(`${API}/channels/${LOCATION_CHANNEL_ID}/messages?limit=1`, {
    headers: botHeaders(env),
  });
  const messages = await res.json();
  if (messages.length === 0) {
    const intro = await sendMessage(env, LOCATION_CHANNEL_ID, [
      "👋 **Welcome to #leave-arrival-alerts!**",
      "This channel is automatically updated by a bot to track who is home. It is triggered by a Shortcut that detects when someone leaves or arrives at the house via geolocation.",
      "​",
      "**Status guide:**",
      "🏠 **Arrived** — Someone has arrived home.",
      "🚶 **Left** — Someone has left home.",
      "🌐 **Location** — A live location ping with a Google Maps link.",
      "​",
      "​",
    ].join("\n"));
    await pinMessage(env, LOCATION_CHANNEL_ID, intro.id);

    const statusContent = await buildStatusBoard(env);
    const statusMsg = await sendMessage(env, LOCATION_CHANNEL_ID, statusContent);
    await pinMessage(env, LOCATION_CHANNEL_ID, statusMsg.id);
    await env.KV.put("status_msg_id", statusMsg.id);
  }
}

// Posts the #laundry-alerts intro and pins it. Only fires if channel is empty.
async function maybePostLaundryIntro(env) {
  const res = await fetch(`${API}/channels/${LAUNDRY_CHANNEL_ID}/messages?limit=1`, {
    headers: botHeaders(env),
  });
  const messages = await res.json();
  if (messages.length === 0) {
    const data = await sendMessage(env, LAUNDRY_CHANNEL_ID, [
      "👋 **Welcome to #laundry-alerts!**",
      "This channel is automatically updated by a bot to track the state of the washer and dryer. The bot is triggered via a Shortcut or NFC tag on the appliances.",
      "​",
      "**Status guide:**",
      "🫧 **Washer Running** — The washer is currently running.",
      "⚠️ **Washer Done** — The washer is done! Move it to the dryer.",
      "🌀 **Dryer Running** — The dryer is currently running.",
      "✅ **Dryer Done** — The dryer is done! Ready to fold.",
      "​",
      "​",
    ].join("\n"));
    await pinMessage(env, LAUNDRY_CHANNEL_ID, data.id);
  }
}

// Posts the #calendar intro and pins it. Also ensures the pinned calendar
// board exists — creates and pins it if calendar_msg_id is not in KV.
// The board check runs even if the intro has already been posted.
async function maybePostCalendarIntro(env) {
  const res = await fetch(`${API}/channels/${CALENDAR_CHANNEL_ID}/messages?limit=1`, {
    headers: botHeaders(env),
  });
  const messages = await res.json();
  if (messages.length === 0) {
    const intro = await sendMessage(env, CALENDAR_CHANNEL_ID, [
      "👋 **Welcome to #calendar!**",
      "This is the shared house calendar. Use slash commands to manage events:",
      "​",
      "📌 `/event title:Dentist date:2026-05-01 time:14:00 reminder:30` — Add an event",
      "❌ `/cancel id:evt_abc123` — Cancel an event by ID",
      "📋 `/events` — List all upcoming events",
      "​",
      "All times are in EST. Event IDs are shown in the calendar below.",
      "​",
      "​",
    ].join("\n"));
    await pinMessage(env, CALENDAR_CHANNEL_ID, intro.id);
  }

  // Always ensure the pinned calendar board exists, even if intro was already posted
  const calMsgId = await env.KV.get("calendar_msg_id");
  if (!calMsgId) {
    const calContent = await buildCalendarBoard(env);
    const calMsg = await sendMessage(env, CALENDAR_CHANNEL_ID, calContent);
    await pinMessage(env, CALENDAR_CHANNEL_ID, calMsg.id);
    await env.KV.put("calendar_msg_id", calMsg.id);
  }
}

// Posts the #bot-api-documentation message and pins it.
// Only fires if the channel is empty.
async function maybePostDocs(env) {
  const res = await fetch(`${API}/channels/${DOCS_CHANNEL_ID}/messages?limit=1`, {
    headers: botHeaders(env),
  });
  const messages = await res.json();
  if (messages.length === 0) {
    const data = await sendMessage(env, DOCS_CHANNEL_ID, [
      "@everyone",
      "# 🤖 house-bot API Documentation",
      `**Source:** <${GITHUB_URL}>`,
      "**Base URL:** `https://discord-shortcut.angeluccimatt4.workers.dev`",
      "> All endpoints are HTTP GET requests and require `?token=TOKEN`. Ask @Snake (<@436947323445313536>) for the token.",
      "> Add `&dev=1` to any request to test in #bot-development-spam (pings suppressed, no channel renames).",
      "",
      "---",
      "",
      "## 🍽️ Dishwasher Alerts",
      "Posts to #dishwasher-alerts. Triggered via Shortcut or NFC tag.",
      "",
      "**`GET /`** — Start a dishwasher cycle",
      "- `minutes` — Estimated runtime *(optional, default: 150)*",
      "Example: `/?token=TOKEN&minutes=90`",
      "",
      "**`GET /unloaded`** — Mark the dishwasher as empty and ready to load",
      "Example: `/unloaded?token=TOKEN`",
      "",
      "---",
      "",
      "## 👕 Laundry Alerts",
      "Posts to #laundry-alerts. Triggered via Shortcut or NFC tag.",
      "",
      "**`GET /washer`** — Start a washer cycle",
      "- `minutes` — Estimated runtime *(optional, default: 45)*",
      "Example: `/washer?token=TOKEN&minutes=60`",
      "",
      "**`GET /dryer`** — Start a dryer cycle",
      "- `minutes` — Estimated runtime *(optional, default: 45)*",
      "Example: `/dryer?token=TOKEN&minutes=60`",
      "",
      "---",
      "",
      "## 📅 Calendar",
      "Managed via slash commands in #calendar. All times in EST.",
      "",
      "`/event title date time [reminder]` — Add an event",
      "`/cancel id` — Cancel an event by ID",
      "`/events` — List all upcoming events",
      "",
      "---",
      "",
      "## 🏠 Leave/Arrival Alerts",
      "Posts to #leave-arrival-alerts. Triggered via geolocation Shortcut.",
      "",
      "**`GET /arrived`** — Mark someone as arrived home",
      "- `person` — e.g. `snake` *(required)*",
      "Example: `/arrived?token=TOKEN&person=snake`",
      "",
      "**`GET /left`** — Mark someone as having left home",
      "- `person` — e.g. `snake` *(required)*",
      "- `destination` — e.g. `Walmart` *(optional)*",
      "Example: `/left?token=TOKEN&person=snake&destination=Walmart`",
      "",
      "**`GET /location`** — Post a live location ping with Google Maps link",
      "- `person` — e.g. `snake` *(required)*",
      "- `lat` + `lon` — GPS coordinates *(optional)*",
      "- `address` — URL-encoded address string *(optional)*",
      "- Either `lat`/`lon` or `address` is required",
      "Example (GPS): `/location?token=TOKEN&person=snake&lat=39.9526&lon=-75.1652`",
      "Example (address): `/location?token=TOKEN&person=snake&address=1600%20Pennsylvania%20Ave`",
      "",
      "---",
      "",
      "## 👤 Supported People",
      "- `snake` — <@436947323445313536>",
      "- `floogin` — <@209825795852599297>",
      "- `toad` — <@424005925859229696>",
      "",
      "---",
      "",
      "## 🧹 Auto-Cleanup",
      "Alert channels are cleaned up every night at **3 AM EST**. Messages older than 7 days are deleted. Pinned messages are always preserved. #calendar is never culled.",
      "Laundry done messages are automatically deleted after **2 hours**.",
      "",
      "---",
      "",
      `📖 Full documentation and source code: <${GITHUB_URL}>`,
    ].join("\n"));
    await pinMessage(env, DOCS_CHANNEL_ID, data.id);
  }
}

// ---------------------------------------------------------------------------
// Durable Objects
// ---------------------------------------------------------------------------

// CullDO — runs once daily at 3 AM EST to delete old messages.
// Started once via maybeStartCuller() on first API invocation.
// Reschedules itself after each run.
export class CullDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
  }

  // Called once to schedule the first alarm
  async fetch(request) {
    const next3AM = getNext3AMEST();
    await this.ctx.storage.setAlarm(next3AM);
    return new Response("Culler scheduled");
  }

  // Runs at 3 AM EST, culls all CULL_CHANNELS, reschedules for next day
  async alarm() {
    const env = this.env;
    console.log("Running daily cull at 3 AM EST");

    for (const channelId of CULL_CHANNELS) {
      try {
        const culled = await cullChannel(env, channelId);
        console.log(`Culled ${culled} messages from ${channelId}`);
      } catch (e) {
        console.error(`Failed to cull ${channelId}:`, e);
      }
    }

    const next3AM = getNext3AMEST();
    await this.ctx.storage.setAlarm(next3AM);
  }
}

// TimerDO — general-purpose timed alarm for all delayed actions:
// - dishwasher/washer/dryer done notifications
// - laundry done message auto-delete (after LAUNDRY_DONE_TTL_MS)
// - calendar event reminders
// - calendar event expiry cleanup
// Each timer is a separate DO instance with its own storage and alarm.
export class TimerDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
  }

  // Stores params and sets the alarm for delayMs milliseconds from now
  async fetch(request) {
    const params = await request.json();
    await this.ctx.storage.put("params", params);
    await this.ctx.storage.setAlarm(Date.now() + params.delayMs);
    return new Response("OK");
  }

  // Fires when the alarm triggers. Restores DEV_MODE from stored params
  // so dev-mode timed messages also route to #bot-development-spam.
  async alarm() {
    const params = await this.ctx.storage.get("params");
    if (!params) return;

    DEV_MODE = params.devMode ?? false;

    const { type, msgid, startTs, eventId, eventTitle, eventTs } = params;
    const env = this.env;

    if (type === "dishwasher") {
      // Edit the running message to show when it ran, then post done alert
      await editMessage(env, CHANNEL_ID, msgid, `🫧 The dishwasher was run at <t:${startTs}:F>.`);
      const data = await sendMessage(env, CHANNEL_ID, `@everyone 🏁 The dishwasher is DONE! Ready to unload!`);
      await env.KV.put("done_msg_id", data.id);
      await setChannelName(env, CHANNEL_ID, "🏁", "dishwasher-alerts");
    } else if (type === "washer") {
      // Edit the running message, post done alert, schedule auto-delete in 2hrs
      await editMessage(env, LAUNDRY_CHANNEL_ID, msgid, `🫧 The washer was run at <t:${startTs}:F>.`);
      const data = await sendMessage(env, LAUNDRY_CHANNEL_ID, `@everyone ⚠️ The washer is DONE! Move it to the dryer.`);
      await env.KV.put(`washer_done_msg_${msgid}`, data.id);
      await setChannelName(env, LAUNDRY_CHANNEL_ID, "⚠️", "laundry-alerts");
      await scheduleTimer(env, "delete_msg", LAUNDRY_DONE_TTL_MS, {
        channelId: LAUNDRY_CHANNEL_ID,
        deleteTargetMsgId: data.id,
      });
    } else if (type === "dryer") {
      // Edit the running message, post done alert, schedule auto-delete in 2hrs
      await editMessage(env, LAUNDRY_CHANNEL_ID, msgid, `🌀 The dryer was run at <t:${startTs}:F>.`);
      const data = await sendMessage(env, LAUNDRY_CHANNEL_ID, `@everyone ✅ The dryer is DONE! Ready to fold.`);
      await env.KV.put(`dryer_done_msg_${msgid}`, data.id);
      await setChannelName(env, LAUNDRY_CHANNEL_ID, "✅", "laundry-alerts");
      await scheduleTimer(env, "delete_msg", LAUNDRY_DONE_TTL_MS, {
        channelId: LAUNDRY_CHANNEL_ID,
        deleteTargetMsgId: data.id,
      });
    } else if (type === "delete_msg") {
      // Deletes a specific message — used for laundry done auto-cleanup
      await fetch(`${API}/channels/${params.channelId}/messages/${params.deleteTargetMsgId}`, {
        method: "DELETE",
        headers: botHeaders(env),
      });
    } else if (type === "event_reminder") {
      // Posts a reminder to #calendar if the event still exists (wasn't cancelled)
      const events = await getEvents(env);
      const event = events.find(e => e.id === eventId);
      if (event) {
        await sendMessage(env, CALENDAR_CHANNEL_ID, `@everyone 🔔 Reminder: **${eventTitle}** is starting <t:${Math.floor(eventTs / 1000)}:R>!`);
      }
    } else if (type === "event_expire") {
      // Prunes expired events from KV and updates the calendar board
      await pruneExpiredEvents(env);
      await updateCalendarBoard(env);
    }

    await this.ctx.storage.delete("params");
  }
}

// Creates a new TimerDO instance and schedules it to fire after delayMs.
// extras are merged into the stored params and available in the alarm handler.
async function scheduleTimer(env, type, delayMs, extras = {}) {
  const id = env.TIMER.newUniqueId();
  const stub = env.TIMER.get(id);
  await stub.fetch("https://internal/set", {
    method: "POST",
    body: JSON.stringify({ type, delayMs, devMode: DEV_MODE, ...extras }),
  });
}

// Starts the CullDO on first API invocation. Uses KV flag "culler_started"
// to ensure it's only initialized once across all worker instances.
async function maybeStartCuller(env) {
  const started = await env.KV.get("culler_started");
  if (!started) {
    const id = env.CULLER.newUniqueId();
    const stub = env.CULLER.get(id);
    await stub.fetch("https://internal/start", { method: "POST" });
    await env.KV.put("culler_started", "1");
    console.log("Culler started, first run at next 3 AM EST");
  }
}

// ---------------------------------------------------------------------------
// Main fetch handler
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // ---------------------------------------------------------------------------
    // Discord interactions endpoint (/interactions)
    // Handles slash commands from Discord. Must respond within 3 seconds,
    // so we return a deferred response (type 5) immediately and do work
    // async via ctx.waitUntil(), then edit the response via webhook.
    // ---------------------------------------------------------------------------
    if (path === "/interactions") {
      const bodyText = await verifyDiscordSignature(request, env);
      if (!bodyText) return new Response("Unauthorized", { status: 401 });

      const interaction = JSON.parse(bodyText);

      // Type 1 = Discord ping verification (required during setup)
      if (interaction.type === 1) {
        return Response.json({ type: 1 });
      }

      // Type 2 = slash command
      if (interaction.type === 2) {
        const { name, options = [] } = interaction.data;
        const token = interaction.token;

        // Respond immediately with "thinking..." to avoid 3s timeout
        const response = new Response(JSON.stringify({ type: 5 }), {
          headers: { "Content-Type": "application/json" },
        });

        // Do actual work after responding, keeping worker alive with waitUntil
        ctx.waitUntil((async () => {
          let reply;
          if (name === "event") {
            reply = await handleEventCommand(env, options);
          } else if (name === "cancel") {
            reply = await handleCancelCommand(env, options);
          } else if (name === "events") {
            reply = await handleEventsCommand(env);
          } else {
            reply = "Unknown command.";
          }

          // Edit the deferred "thinking..." message with the actual reply
          await fetch(`${API}/webhooks/${APP_ID}/${token}/messages/@original`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: reply }),
          });
        })());

        return response;
      }

      return Response.json({ type: 1 });
    }

    // ---------------------------------------------------------------------------
    // HTTP API endpoints — all require ?token=TOKEN
    // ---------------------------------------------------------------------------
    if (url.searchParams.get("token") !== TOKEN) {
      return new Response("Unauthorized", { status: 401 });
    }

    // Set dev mode for this request (persists into timer params for followups)
    DEV_MODE = url.searchParams.get("dev") === "1";

    // Run on every request — idempotent, only posts if channels are empty
    await maybePostDocs(env);
    await maybePostGeneral(env);
    await maybeStartCuller(env);

    // --- Dishwasher ---

    if (path === "/unloaded") {
      const doneMsgId = await env.KV.get("done_msg_id");
      if (doneMsgId) await deleteMessage(env, CHANNEL_ID, doneMsgId);
      const data = await sendMessage(env, CHANNEL_ID, `@everyone 🟩 The dishwasher is empty and ready to be loaded!`);
      await env.KV.put("empty_msg_id", data.id);
      await setChannelName(env, CHANNEL_ID, "🟩", "dishwasher-alerts");
      return new Response("Done!");
    }

    // --- Laundry ---
    // Note: washer and dryer are fully independent — starting one does not
    // affect the other's timer or messages. Concurrent loads are supported.

    if (path === "/washer") {
      await maybePostLaundryIntro(env);
      const minutes = parseInt(url.searchParams.get("minutes") || "45");
      const startTs = Math.floor(Date.now() / 1000);
      const future = startTs + minutes * 60;
      const data = await sendMessage(env, LAUNDRY_CHANNEL_ID, `@everyone 🫧 The washer is RUNNING. It will be done <t:${future}:R>`);
      await setChannelName(env, LAUNDRY_CHANNEL_ID, "🫧", "laundry-alerts");
      await scheduleTimer(env, "washer", minutes * 60 * 1000, { msgid: data.id, startTs });
      return new Response("Started!");
    }

    if (path === "/dryer") {
      await maybePostLaundryIntro(env);
      const minutes = parseInt(url.searchParams.get("minutes") || "45");
      const startTs = Math.floor(Date.now() / 1000);
      const future = startTs + minutes * 60;
      const data = await sendMessage(env, LAUNDRY_CHANNEL_ID, `@everyone 🌀 The dryer is RUNNING. It will be done <t:${future}:R>`);
      await setChannelName(env, LAUNDRY_CHANNEL_ID, "🌀", "laundry-alerts");
      await scheduleTimer(env, "dryer", minutes * 60 * 1000, { msgid: data.id, startTs });
      return new Response("Started!");
    }

    // --- Leave/Arrival ---

    if (path === "/arrived") {
      const personRaw = url.searchParams.get("person");
      if (!personRaw) return new Response("Missing person", { status: 400 });
      const person = PEOPLE[personRaw.toLowerCase()] ?? personRaw;
      const key = personRaw.toLowerCase();
      const ts = Math.floor(Date.now() / 1000);
      await env.KV.put(`status_${key}`, JSON.stringify({ type: "arrived", ts }));
      await maybePostLocationIntro(env);
      await sendMessage(env, LOCATION_CHANNEL_ID, `🏠 ${person} has arrived home! (@here)`);
      await setChannelName(env, LOCATION_CHANNEL_ID, "🏠", "leave-arrival-alerts");
      await updateStatusBoard(env);
      return new Response("Done!");
    }

    if (path === "/left") {
      const personRaw = url.searchParams.get("person");
      if (!personRaw) return new Response("Missing person", { status: 400 });
      const person = PEOPLE[personRaw.toLowerCase()] ?? personRaw;
      const key = personRaw.toLowerCase();
      const ts = Math.floor(Date.now() / 1000);
      const destination = url.searchParams.get("destination");
      await env.KV.put(`status_${key}`, JSON.stringify({ type: "left", ts, destination: destination || null }));
      const message = destination
        ? `🚶 ${person} has left home and gone to ${destination}. (@here)`
        : `🚶 ${person} has left home. (@here)`;
      await maybePostLocationIntro(env);
      await sendMessage(env, LOCATION_CHANNEL_ID, message);
      await setChannelName(env, LOCATION_CHANNEL_ID, "🚶", "leave-arrival-alerts");
      await updateStatusBoard(env);
      return new Response("Done!");
    }

    if (path === "/location") {
      const personRaw = url.searchParams.get("person");
      const lat = url.searchParams.get("lat");
      const lon = url.searchParams.get("lon");
      const address = url.searchParams.get("address");

      if (!personRaw) return new Response("Missing person", { status: 400 });
      if (!address && (!lat || !lon)) return new Response("Missing lat/lon or address", { status: 400 });

      const person = PEOPLE[personRaw.toLowerCase()] ?? personRaw;
      const key = personRaw.toLowerCase();
      const ts = Math.floor(Date.now() / 1000);

      let mapsLink, placeText;

      if (address) {
        // Address string passed directly (URL-encoded by Shortcut)
        mapsLink = `https://www.google.com/maps?q=${encodeURIComponent(address)}`;
        placeText = ` (${address})`;
      } else {
        // GPS coords — reverse geocode to get human-readable place name
        mapsLink = `https://www.google.com/maps?q=${lat},${lon}`;
        const place = await reverseGeocode(env, lat, lon);
        placeText = place ? ` (${place})` : "";
      }

      await env.KV.put(`status_${key}`, JSON.stringify({ type: "location", ts, mapsLink, place: placeText.replace(/[()]/g, "").trim() }));
      await maybePostLocationIntro(env);
      await sendMessage(env, LOCATION_CHANNEL_ID, `🌐 ${person} is here!${placeText} ${mapsLink} (@here)`);
      await updateStatusBoard(env);
      return new Response("Done!");
    }

    // --- Default path: /run (dishwasher) ---
    // Clears any existing empty/done messages, posts running message,
    // schedules a TimerDO alarm for when the cycle finishes.
    const emptyMsgId = await env.KV.get("empty_msg_id");
    if (emptyMsgId) await deleteMessage(env, CHANNEL_ID, emptyMsgId);
    const doneMsgId = await env.KV.get("done_msg_id");
    if (doneMsgId) await deleteMessage(env, CHANNEL_ID, doneMsgId);
    await maybePostIntro(env);
    const minutes = parseInt(url.searchParams.get("minutes") || "150");
    const startTs = Math.floor(Date.now() / 1000);
    const future = startTs + minutes * 60;
    const data = await sendMessage(env, CHANNEL_ID, `@everyone 🔴 The dishwasher is RUNNING. It will be done <t:${future}:R>`);
    await env.KV.put("running_msg_id", data.id);
    await setChannelName(env, CHANNEL_ID, "🔴", "dishwasher-alerts");
    await scheduleTimer(env, "dishwasher", minutes * 60 * 1000, { msgid: data.id, startTs });
    return new Response("Started!");
  },
};
