import { DurableObject } from "cloudflare:workers";

const TOKEN = "VXHeXQe7dn2SGMSK5B";
const CHANNEL_ID = "1497845829938188339";
const LOCATION_CHANNEL_ID = "1498080106927886355";
const DOCS_CHANNEL_ID = "1498080983570845816";
const LAUNDRY_CHANNEL_ID = "1498166929343643790";
const GENERAL_CHANNEL_ID = "1497871726162350180";
const CALENDAR_CHANNEL_ID = "1498206238339760158";
const DEV_CHANNEL_ID = "1497815253311029381";
const APP_ID = "1497846686624776363";
const API = "https://discord.com/api/v10";
const TZ = "America/New_York";
const GITHUB_URL = "https://github.com/mangoALCATRAZ/house-bot";

let DEV_MODE = false;

const PEOPLE = {
  "snake": "<@436947323445313536>",
  "floogin": "<@209825795852599297>",
  "toad": "<@424005925859229696>",
};

const CULL_CHANNELS = [CHANNEL_ID, LAUNDRY_CHANNEL_ID, LOCATION_CHANNEL_ID];
const CULL_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function botHeaders(env) {
  return {
    "Authorization": `Bot ${env.DISCORD_TOKEN}`,
    "Content-Type": "application/json",
  };
}

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

async function editMessage(env, channelId, msgId, content) {
  if (DEV_MODE) return;
  await fetch(`${API}/channels/${channelId}/messages/${msgId}`, {
    method: "PATCH",
    headers: botHeaders(env),
    body: JSON.stringify({ content }),
  });
}

async function deleteMessage(env, channelId, msgId) {
  if (DEV_MODE) return;
  await fetch(`${API}/channels/${channelId}/messages/${msgId}`, {
    method: "DELETE",
    headers: botHeaders(env),
  });
}

async function pinMessage(env, channelId, msgId) {
  if (DEV_MODE) return;
  await fetch(`${API}/channels/${channelId}/pins/${msgId}`, {
    method: "PUT",
    headers: botHeaders(env),
  });
}

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

async function getPinnedIds(env, channelId) {
  const res = await fetch(`${API}/channels/${channelId}/pins`, {
    headers: botHeaders(env),
  });
  const pins = await res.json();
  return Array.isArray(pins) ? pins.map(p => p.id) : [];
}

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
function parseEventTime(date, time) {
  const localDate = new Date(`${date}T${time}:00`);
  const tzOffset =
    new Date(localDate.toLocaleString("en-US", { timeZone: "UTC" })) -
    new Date(localDate.toLocaleString("en-US", { timeZone: TZ }));
  return new Date(localDate.getTime() + tzOffset);
}

async function getEvents(env) {
  const raw = await env.KV.get("calendar_events");
  return raw ? JSON.parse(raw) : [];
}

async function saveEvents(env, events) {
  await env.KV.put("calendar_events", JSON.stringify(events));
}

async function pruneExpiredEvents(env) {
  const events = await getEvents(env);
  const now = Date.now();
  const upcoming = events.filter(e => e.ts > now);
  if (upcoming.length !== events.length) await saveEvents(env, upcoming);
  return upcoming;
}

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

async function updateCalendarBoard(env) {
  const calMsgId = await env.KV.get("calendar_msg_id");
  const content = await buildCalendarBoard(env);
  if (calMsgId) await editMessage(env, CALENDAR_CHANNEL_ID, calMsgId, content);
}

// ---------------------------------------------------------------------------
// Slash command handlers
// ---------------------------------------------------------------------------
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

  const reminderDelay = eventTs - now - reminder * 60 * 1000;
  if (reminderDelay > 0) {
    await scheduleTimer(env, "event_reminder", reminderDelay, {
      eventId: id, eventTitle: title, eventTs,
    });
  }

  await scheduleTimer(env, "event_expire", eventTs - now + 60000, { eventId: id });
  await updateCalendarBoard(env);
  await sendMessage(env, CALENDAR_CHANNEL_ID, `@here 📅 New event added: **${title}** — <t:${Math.floor(eventTs / 1000)}:F> 🔔 Reminder ${reminder} min before. 🆔 \`${id}\``);

  return `✅ Event **${title}** added for <t:${Math.floor(eventTs / 1000)}:F>! ID: \`${id}\``;
}

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
// Status board
// ---------------------------------------------------------------------------
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

async function updateStatusBoard(env) {
  const statusMsgId = await env.KV.get("status_msg_id");
  const content = await buildStatusBoard(env);
  if (statusMsgId) await editMessage(env, LOCATION_CHANNEL_ID, statusMsgId, content);
}

// ---------------------------------------------------------------------------
// Intro posts
// ---------------------------------------------------------------------------
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

  const calMsgId = await env.KV.get("calendar_msg_id");
  if (!calMsgId) {
    const calContent = await buildCalendarBoard(env);
    const calMsg = await sendMessage(env, CALENDAR_CHANNEL_ID, calContent);
    await pinMessage(env, CALENDAR_CHANNEL_ID, calMsg.id);
    await env.KV.put("calendar_msg_id", calMsg.id);
  }
}

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
      "- `lat` — Latitude *(required)*",
      "- `lon` — Longitude *(required)*",
      "Example: `/location?token=TOKEN&person=snake&lat=39.9526&lon=-75.1652`",
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
      "",
      "---",
      "",
      `📖 Full documentation and source code: <${GITHUB_URL}>`,
    ].join("\n"));
    await pinMessage(env, DOCS_CHANNEL_ID, data.id);
  }
}

// ---------------------------------------------------------------------------
// Cull DO
// ---------------------------------------------------------------------------
export class CullDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const next3AM = getNext3AMEST();
    await this.ctx.storage.setAlarm(next3AM);
    return new Response("Culler scheduled");
  }

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

// ---------------------------------------------------------------------------
// Timer DO
// ---------------------------------------------------------------------------
export class TimerDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const params = await request.json();
    await this.ctx.storage.put("params", params);
    await this.ctx.storage.setAlarm(Date.now() + params.delayMs);
    return new Response("OK");
  }

  async alarm() {
    const params = await this.ctx.storage.get("params");
    if (!params) return;

    DEV_MODE = params.devMode ?? false;

    const { type, msgid, startTs, eventId, eventTitle, eventTs } = params;
    const env = this.env;

    if (type === "dishwasher") {
      await editMessage(env, CHANNEL_ID, msgid, `🫧 The dishwasher was run at <t:${startTs}:F>.`);
      const data = await sendMessage(env, CHANNEL_ID, `@everyone 🏁 The dishwasher is DONE! Ready to unload!`);
      await env.KV.put("done_msg_id", data.id);
      await setChannelName(env, CHANNEL_ID, "🏁", "dishwasher-alerts");
    } else if (type === "washer") {
      await editMessage(env, LAUNDRY_CHANNEL_ID, msgid, `🫧 The washer was run at <t:${startTs}:F>.`);
      const data = await sendMessage(env, LAUNDRY_CHANNEL_ID, `@everyone ⚠️ The washer is DONE! Move it to the dryer.`);
      await env.KV.put(`washer_done_msg_${msgid}`, data.id);
      await setChannelName(env, LAUNDRY_CHANNEL_ID, "⚠️", "laundry-alerts");
    } else if (type === "dryer") {
      await editMessage(env, LAUNDRY_CHANNEL_ID, msgid, `🌀 The dryer was run at <t:${startTs}:F>.`);
      const data = await sendMessage(env, LAUNDRY_CHANNEL_ID, `@everyone ✅ The dryer is DONE! Ready to fold.`);
      await env.KV.put(`dryer_done_msg_${msgid}`, data.id);
      await setChannelName(env, LAUNDRY_CHANNEL_ID, "✅", "laundry-alerts");
    } else if (type === "event_reminder") {
      const events = await getEvents(env);
      const event = events.find(e => e.id === eventId);
      if (event) {
        await sendMessage(env, CALENDAR_CHANNEL_ID, `@everyone 🔔 Reminder: **${eventTitle}** is starting <t:${Math.floor(eventTs / 1000)}:R>!`);
      }
    } else if (type === "event_expire") {
      await pruneExpiredEvents(env);
      await updateCalendarBoard(env);
    }

    await this.ctx.storage.delete("params");
  }
}

async function scheduleTimer(env, type, delayMs, extras = {}) {
  const id = env.TIMER.newUniqueId();
  const stub = env.TIMER.get(id);
  await stub.fetch("https://internal/set", {
    method: "POST",
    body: JSON.stringify({ type, delayMs, devMode: DEV_MODE, ...extras }),
  });
}

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
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/interactions") {
      const bodyText = await verifyDiscordSignature(request, env);
      if (!bodyText) return new Response("Unauthorized", { status: 401 });

      const interaction = JSON.parse(bodyText);

      if (interaction.type === 1) {
        return Response.json({ type: 1 });
      }

      if (interaction.type === 2) {
        const { name, options = [] } = interaction.data;
        const token = interaction.token;

        const response = new Response(JSON.stringify({ type: 5 }), {
          headers: { "Content-Type": "application/json" },
        });

        (async () => {
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

          await fetch(`${API}/webhooks/${APP_ID}/${token}/messages/@original`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: reply }),
          });
        })();

        return response;
      }

      return Response.json({ type: 1 });
    }

    if (url.searchParams.get("token") !== TOKEN) {
      return new Response("Unauthorized", { status: 401 });
    }

    DEV_MODE = url.searchParams.get("dev") === "1";

    await maybePostDocs(env);
    await maybePostGeneral(env);
    await maybeStartCuller(env);

    if (path === "/unloaded") {
      const doneMsgId = await env.KV.get("done_msg_id");
      if (doneMsgId) await deleteMessage(env, CHANNEL_ID, doneMsgId);
      const data = await sendMessage(env, CHANNEL_ID, `@everyone 🟩 The dishwasher is empty and ready to be loaded!`);
      await env.KV.put("empty_msg_id", data.id);
      await setChannelName(env, CHANNEL_ID, "🟩", "dishwasher-alerts");
      return new Response("Done!");
    }

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
      if (!personRaw || !lat || !lon) return new Response("Missing person, lat, or lon", { status: 400 });
      const person = PEOPLE[personRaw.toLowerCase()] ?? personRaw;
      const key = personRaw.toLowerCase();
      const ts = Math.floor(Date.now() / 1000);
      const mapsLink = `https://www.google.com/maps?q=${lat},${lon}`;
      const place = await reverseGeocode(env, lat, lon);
      const placeText = place ? ` (${place})` : "";
      await env.KV.put(`status_${key}`, JSON.stringify({ type: "location", ts, mapsLink, place }));
      await maybePostLocationIntro(env);
      await sendMessage(env, LOCATION_CHANNEL_ID, `🌐 ${person} is here!${placeText} ${mapsLink} (@here)`);
      await updateStatusBoard(env);
      return new Response("Done!");
    }

    // /run — default dishwasher path
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
