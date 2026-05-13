import { DurableObject } from "cloudflare:workers";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOKEN = "VXHeXQe7dn2SGMSK5B";

const CHANNEL_ID = "1497845829938188339";           // #dishwasher-alerts
const LOCATION_CHANNEL_ID = "1498080106927886355";  // #leave-arrival-alerts
const DOCS_CHANNEL_ID = "1498080983570845816";      // #bot-api-documentation
const LAUNDRY_CHANNEL_ID = "1498166929343643790";   // #laundry-alerts
const GENERAL_CHANNEL_ID = "1497871726162350180";   // #general
const CALENDAR_CHANNEL_ID = "1498206238339760158";  // #calendar
const DEV_CHANNEL_ID = "1497815253311029381";       // #bot-development-spam

const APP_ID = "1497846686624776363";
const API = "https://discord.com/api/v10";
const TZ = "America/New_York";
const GITHUB_URL = "https://github.com/mangoALCATRAZ/house-bot";

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------
const PEOPLE = {
  "snake": "<@436947323445313536>",
  "floogin": "<@209825795852599297>",
  "toad": "<@424005925859229696>",
};

// ---------------------------------------------------------------------------
// Cull config
// ---------------------------------------------------------------------------
const CULL_CHANNELS = [CHANNEL_ID, LAUNDRY_CHANNEL_ID, LOCATION_CHANNEL_ID, CALENDAR_CHANNEL_ID];
const CULL_AGE_MS = 2 * 24 * 60 * 60 * 1000;
const PROTECTED_KV_KEYS = ["status_msg_id", "calendar_msg_id"];

// ---------------------------------------------------------------------------
// Discord API helpers
// ---------------------------------------------------------------------------

function botHeaders(env) {
  return {
    "Authorization": `Bot ${env.DISCORD_TOKEN}`,
    "Content-Type": "application/json",
  };
}

async function sendMessage(env, channelId, content, devMode = false) {
  const targetChannel = devMode ? DEV_CHANNEL_ID : channelId;
  const finalContent = devMode
    ? `[→ <#${channelId}>] ${content.replace(/@everyone/g, "").replace(/@here/g, "").trim()}`
    : content;
  const res = await fetch(`${API}/channels/${targetChannel}/messages`, {
    method: "POST",
    headers: botHeaders(env),
    body: JSON.stringify({ content: finalContent }),
  });
  return res.json();
}

async function sendEmbeds(env, channelId, content, embeds, devMode = false) {
  const targetChannel = devMode ? DEV_CHANNEL_ID : channelId;
  const finalContent = devMode
    ? `[→ <#${channelId}>] ${(content || "").replace(/@everyone/g, "").replace(/@here/g, "").trim()}`
    : (content || "");
  const res = await fetch(`${API}/channels/${targetChannel}/messages`, {
    method: "POST",
    headers: botHeaders(env),
    body: JSON.stringify({ content: finalContent, embeds }),
  });
  return res.json();
}

async function editEmbeds(env, channelId, msgId, content, embeds, devMode = false) {
  if (devMode) return;
  await fetch(`${API}/channels/${channelId}/messages/${msgId}`, {
    method: "PATCH",
    headers: botHeaders(env),
    body: JSON.stringify({ content: content || "", embeds }),
  });
}

async function editMessage(env, channelId, msgId, content, devMode = false) {
  if (devMode) return;
  await fetch(`${API}/channels/${channelId}/messages/${msgId}`, {
    method: "PATCH",
    headers: botHeaders(env),
    body: JSON.stringify({ content }),
  });
}

async function deleteMessage(env, channelId, msgId, devMode = false) {
  if (devMode) return;
  await fetch(`${API}/channels/${channelId}/messages/${msgId}`, {
    method: "DELETE",
    headers: botHeaders(env),
  });
}

async function pinMessage(env, channelId, msgId, devMode = false) {
  if (devMode) return;
  await fetch(`${API}/channels/${channelId}/pins/${msgId}`, {
    method: "PUT",
    headers: botHeaders(env),
  });
}

async function setChannelName(env, channelId, emoji, baseName, devMode = false) {
  if (devMode) return;
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

async function getProtectedIds(env, channelId) {
  const pinnedIds = await getPinnedIds(env, channelId);
  const kvIds = await Promise.all(PROTECTED_KV_KEYS.map(key => env.KV.get(key)));
  return [...new Set([...pinnedIds, ...kvIds.filter(Boolean)])];
}

async function cullChannel(env, channelId, cutoffMs) {
  const protectedIds = await getProtectedIds(env, channelId);
  const cutoff = Date.now() - cutoffMs;
  console.log(`cullChannel: channel=${channelId} cutoff=${new Date(cutoff).toISOString()} protected=${protectedIds.length}`);
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
      if (msgTs > cutoff) { lastId = msg.id; continue; }
      if (protectedIds.includes(msg.id)) continue;
      const delRes = await fetch(`${API}/channels/${channelId}/messages/${msg.id}`, {
        method: "DELETE",
        headers: botHeaders(env),
      });
      console.log(`deleted msg ${msg.id}: status=${delRes.status}`);
      culled++;
      await new Promise(r => setTimeout(r, 500));
    }

    const oldest = messages[messages.length - 1];
    const oldestTs = Number(BigInt(oldest.id) >> 22n) + 1420070400000;
    if (oldestTs < cutoff) break;
    lastId = oldest.id;
  }

  console.log(`cullChannel done: culled=${culled} from ${channelId}`);
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
  const naive = new Date(`${date}T${time}:00`);
  const utcStr = naive.toLocaleString("en-US", { timeZone: "UTC" });
  const estStr = naive.toLocaleString("en-US", { timeZone: TZ });
  const tzOffset = new Date(utcStr) - new Date(estStr);
  return new Date(naive.getTime() + tzOffset);
}

// Converts reminder value + unit to minutes
function toMinutes(value, unit) {
  switch (unit) {
    case "hours": return value * 60;
    case "days": return value * 60 * 24;
    case "weeks": return value * 60 * 24 * 7;
    default: return value; // minutes
  }
}

// Human-readable reminder label e.g. "1 day", "2 hours", "30 minutes"
function reminderLabel(value, unit) {
  const singular = value === 1;
  switch (unit) {
    case "hours": return `${value} ${singular ? "hour" : "hours"}`;
    case "days": return `${value} ${singular ? "day" : "days"}`;
    case "weeks": return `${value} ${singular ? "week" : "weeks"}`;
    default: return `${value} ${singular ? "minute" : "minutes"}`;
  }
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

// Builds one Discord embed per event for the Upcoming Events board
function buildEventEmbed(event) {
  const ts = Math.floor(event.ts / 1000);
  const embed = {
    title: `📌 ${event.title}`,
    color: 0x5865F2,
    fields: [
      { name: "When", value: `<t:${ts}:F> (<t:${ts}:R>)`, inline: false },
      { name: "Reminder", value: event.reminderLabel || `${event.reminder} minutes`, inline: true },
      { name: "ID", value: `\`${event.id}\``, inline: true },
    ],
  };
  if (event.locationName && event.locationUrl) {
    embed.fields.push({ name: "Location", value: `[${event.locationName}](${event.locationUrl})`, inline: false });
  } else if (event.locationName) {
    embed.fields.push({ name: "Location", value: event.locationName, inline: false });
  }
  if (event.image) {
    embed.image = { url: event.image };
  }
  return embed;
}

// Edits the pinned Upcoming Events board with one embed per event (max 10)
async function updateCalendarBoard(env, devMode = false) {
  const calMsgId = await env.KV.get("calendar_msg_id");
  if (!calMsgId) return;

  const events = await pruneExpiredEvents(env);
  const sorted = [...events].sort((a, b) => a.ts - b.ts);

  if (sorted.length === 0) {
    await editEmbeds(env, CALENDAR_CHANNEL_ID, calMsgId, "📅 **Upcoming Events**\n\nNo upcoming events.", [], devMode);
  } else {
    const embeds = sorted.slice(0, 10).map(buildEventEmbed);
    await editEmbeds(env, CALENDAR_CHANNEL_ID, calMsgId, "📅 **Upcoming Events**", embeds, devMode);
  }
}

// ---------------------------------------------------------------------------
// Slash command handlers
// ---------------------------------------------------------------------------

async function handleEventCommand(env, options, devMode) {
  const title = options.find(o => o.name === "title")?.value;
  const date = options.find(o => o.name === "date")?.value;
  const time = options.find(o => o.name === "time")?.value;
  const reminderValue = options.find(o => o.name === "reminder")?.value ?? 30;
  const reminderUnit = options.find(o => o.name === "reminder_unit")?.value ?? "minutes";
  const image = options.find(o => o.name === "image")?.value ?? null;
  const locationName = options.find(o => o.name === "location_name")?.value ?? null;
  const locationUrl = options.find(o => o.name === "location_url")?.value ?? null;

  if (!title || !date || !time) return "❌ Missing title, date, or time.";

  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  const timeRegex = /^\d{2}:\d{2}$/;
  if (!dateRegex.test(date)) return "❌ Date must be in YYYY-MM-DD format.";
  if (!timeRegex.test(time)) return "❌ Time must be in HH:MM format (24h EST).";

  const eventDate = parseEventTime(date, time);
  const eventTs = eventDate.getTime();
  const now = Date.now();

  if (eventTs <= now) return "❌ Event date is in the past.";

  await maybePostCalendarIntro(env, devMode);

  // Convert reminder to minutes for scheduling, store label for display
  const reminderMinutes = toMinutes(reminderValue, reminderUnit);
  const label = reminderLabel(reminderValue, reminderUnit);

  const id = `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const event = { id, title, ts: eventTs, reminder: reminderMinutes, reminderLabel: label, image, locationName, locationUrl };
  const events = await getEvents(env);
  events.push(event);
  await saveEvents(env, events);

  await updateCalendarBoard(env, devMode);

  const reminderDelay = eventTs - now - reminderMinutes * 60 * 1000;
  if (reminderDelay > 0) {
    await scheduleTimer(env, "event_reminder", reminderDelay, {
      eventId: id, eventTitle: title, eventTs, devMode,
    });
  }
  await scheduleTimer(env, "event_expire", eventTs - now + 60000, { eventId: id, devMode });

  await sendMessage(env, CALENDAR_CHANNEL_ID,
    `@here 📅 New event added: **${title}** — <t:${Math.floor(eventTs / 1000)}:F> 🔔 Reminder ${label} before. 🆔 \`${id}\``,
    devMode
  );

  return `✅ Event **${title}** added for <t:${Math.floor(eventTs / 1000)}:F>! Reminder: ${label} before. ID: \`${id}\``;
}

async function handleCancelCommand(env, options, devMode) {
  const id = options.find(o => o.name === "id")?.value;
  if (!id) return "❌ Missing event ID.";

  const events = await getEvents(env);
  const idx = events.findIndex(e => e.id === id);
  if (idx === -1) return "❌ Event not found. Check the ID in the calendar.";

  const [removed] = events.splice(idx, 1);
  await saveEvents(env, events);
  await updateCalendarBoard(env, devMode);

  await sendMessage(env, CALENDAR_CHANNEL_ID,
    `@here ❌ Event cancelled: **${removed.title}** (<t:${Math.floor(removed.ts / 1000)}:F>)`,
    devMode
  );

  return `✅ Event **${removed.title}** cancelled.`;
}

async function handleEventsCommand(env) {
  const events = await pruneExpiredEvents(env);
  if (events.length === 0) return "📅 No upcoming events.";

  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  const lines = ["📅 **Upcoming Events**", ""];
  for (const e of sorted) {
    const ts = Math.floor(e.ts / 1000);
    let line = `📌 **${e.title}** — <t:${ts}:F> (<t:${ts}:R>) 🆔 \`${e.id}\``;
    if (e.locationName) line += ` 📍 ${e.locationName}`;
    lines.push(line);
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

async function updateStatusBoard(env, devMode = false) {
  const statusMsgId = await env.KV.get("status_msg_id");
  const content = await buildStatusBoard(env);
  if (statusMsgId) await editMessage(env, LOCATION_CHANNEL_ID, statusMsgId, content, devMode);
}

// ---------------------------------------------------------------------------
// Channel intro posts
// ---------------------------------------------------------------------------

async function maybePostGeneral(env, devMode) {
  const posted = await env.KV.get("general_intro_posted");
  if (posted) return;
  const res = await fetch(`${API}/channels/${GENERAL_CHANNEL_ID}/messages?limit=1`, { headers: botHeaders(env) });
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
    ].join("\n"), devMode);
    await pinMessage(env, GENERAL_CHANNEL_ID, data.id, devMode);
    await env.KV.put("general_intro_posted", "1");
  }
}

async function maybePostDocs(env, devMode) {
  const posted = await env.KV.get("docs_intro_posted");
  if (posted) return;
  const res = await fetch(`${API}/channels/${DOCS_CHANNEL_ID}/messages?limit=1`, { headers: botHeaders(env) });
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
      "`/event title date time [reminder] [reminder_unit] [image] [location_name] [location_url]` — Add an event",
      "- `reminder_unit`: minutes (default), hours, days, weeks",
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
      "All channels culled once daily at **3 AM EST**. Messages older than **2 days** are deleted. Pinned messages and status boards always preserved.",
      "",
      "---",
      "",
      `📖 Full documentation and source code: <${GITHUB_URL}>`,
    ].join("\n"), devMode);
    await pinMessage(env, DOCS_CHANNEL_ID, data.id, devMode);
    await env.KV.put("docs_intro_posted", "1");
  }
}

async function maybePostIntro(env, devMode) {
  const posted = await env.KV.get("dishwasher_intro_posted");
  if (posted) return;
  const res = await fetch(`${API}/channels/${CHANNEL_ID}/messages?limit=1`, { headers: botHeaders(env) });
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
    ].join("\n"), devMode);
    await pinMessage(env, CHANNEL_ID, data.id, devMode);
    await env.KV.put("dishwasher_intro_posted", "1");
  }
}

async function maybePostLocationIntro(env, devMode) {
  const posted = await env.KV.get("location_intro_posted");
  if (posted) return;
  const res = await fetch(`${API}/channels/${LOCATION_CHANNEL_ID}/messages?limit=1`, { headers: botHeaders(env) });
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
    ].join("\n"), devMode);
    await pinMessage(env, LOCATION_CHANNEL_ID, intro.id, devMode);

    const statusContent = await buildStatusBoard(env);
    const statusMsg = await sendMessage(env, LOCATION_CHANNEL_ID, statusContent, devMode);
    await pinMessage(env, LOCATION_CHANNEL_ID, statusMsg.id, devMode);
    await env.KV.put("status_msg_id", statusMsg.id);
    await env.KV.put("location_intro_posted", "1");
  }
}

async function maybePostLaundryIntro(env, devMode) {
  const posted = await env.KV.get("laundry_intro_posted");
  if (posted) return;
  const res = await fetch(`${API}/channels/${LAUNDRY_CHANNEL_ID}/messages?limit=1`, { headers: botHeaders(env) });
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
    ].join("\n"), devMode);
    await pinMessage(env, LAUNDRY_CHANNEL_ID, data.id, devMode);
    await env.KV.put("laundry_intro_posted", "1");
  }
}

async function maybePostCalendarIntro(env, devMode) {
  const posted = await env.KV.get("calendar_intro_posted");
  if (!posted) {
    const res = await fetch(`${API}/channels/${CALENDAR_CHANNEL_ID}/messages?limit=1`, { headers: botHeaders(env) });
    const messages = await res.json();
    if (messages.length === 0) {
      const intro = await sendMessage(env, CALENDAR_CHANNEL_ID, [
        "👋 **Welcome to #calendar!**",
        "This is the shared house calendar. Use slash commands to manage events:",
        "​",
        "📌 `/event title:Dentist date:2026-05-01 time:14:00 reminder:1 reminder_unit:days` — Add an event",
        "❌ `/cancel id:evt_abc123` — Cancel an event by ID",
        "📋 `/events` — List all upcoming events",
        "​",
        "All times are in EST. Reminder units: minutes (default), hours, days, weeks. Location and image are optional.",
        "​",
        "​",
      ].join("\n"), devMode);
      await pinMessage(env, CALENDAR_CHANNEL_ID, intro.id, devMode);
      await env.KV.put("calendar_intro_posted", "1");
    }
  }

  const calMsgId = await env.KV.get("calendar_msg_id");
  if (!calMsgId) {
    const boardMsg = await sendEmbeds(env, CALENDAR_CHANNEL_ID, "📅 **Upcoming Events**", [], devMode);
    if (boardMsg.id) {
      await pinMessage(env, CALENDAR_CHANNEL_ID, boardMsg.id, devMode);
      await env.KV.put("calendar_msg_id", boardMsg.id);
    }
  }
}

// ---------------------------------------------------------------------------
// Durable Objects
// ---------------------------------------------------------------------------

export class CullDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    console.log("CullDO: starting initial run");
    await this.alarm();
    await this.ctx.storage.setAlarm(getNext3AMEST());
    return new Response("Culler started and scheduled for 3 AM EST");
  }

  async alarm() {
    const env = this.env;
    console.log("CullDO: running daily 3 AM cull");
    for (const channelId of CULL_CHANNELS) {
      try {
        const culled = await cullChannel(env, channelId, CULL_AGE_MS);
        console.log(`Culled ${culled} messages from ${channelId}`);
      } catch (e) {
        console.error(`Cull failed for ${channelId}:`, e);
      }
    }
    await this.ctx.storage.setAlarm(getNext3AMEST());
  }
}

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

    const { type, msgid, startTs, eventId, eventTitle, eventTs, devMode = false } = params;
    const env = this.env;

    if (type === "dishwasher") {
      await editMessage(env, CHANNEL_ID, msgid, `🫧 The dishwasher was run at <t:${startTs}:F>.`, devMode);
      const data = await sendMessage(env, CHANNEL_ID, `@everyone 🏁 The dishwasher is DONE! Ready to unload!`, devMode);
      await env.KV.put("done_msg_id", data.id);
      await setChannelName(env, CHANNEL_ID, "🏁", "dishwasher-alerts", devMode);
    } else if (type === "washer") {
      await editMessage(env, LAUNDRY_CHANNEL_ID, msgid, `🫧 The washer was run at <t:${startTs}:F>.`, devMode);
      await sendMessage(env, LAUNDRY_CHANNEL_ID, `⚠️ The washer is DONE! Move it to the dryer.`, devMode);
      await setChannelName(env, LAUNDRY_CHANNEL_ID, "⚠️", "laundry-alerts", devMode);
    } else if (type === "dryer") {
      await editMessage(env, LAUNDRY_CHANNEL_ID, msgid, `🌀 The dryer was run at <t:${startTs}:F>.`, devMode);
      await sendMessage(env, LAUNDRY_CHANNEL_ID, `✅ The dryer is DONE! Ready to fold.`, devMode);
      await setChannelName(env, LAUNDRY_CHANNEL_ID, "✅", "laundry-alerts", devMode);
    } else if (type === "event_reminder") {
      const events = await getEvents(env);
      const event = events.find(e => e.id === eventId);
      if (event) {
        await sendMessage(env, CALENDAR_CHANNEL_ID, `@everyone 🔔 Reminder: **${eventTitle}** is starting <t:${Math.floor(eventTs / 1000)}:R>!`, devMode);
      }
    } else if (type === "event_expire") {
      await pruneExpiredEvents(env);
      await updateCalendarBoard(env, devMode);
    }

    await this.ctx.storage.delete("params");
  }
}

async function scheduleTimer(env, type, delayMs, extras = {}) {
  const id = env.TIMER.newUniqueId();
  const stub = env.TIMER.get(id);
  await stub.fetch("https://internal/set", {
    method: "POST",
    body: JSON.stringify({ type, delayMs, ...extras }),
  });
}

async function maybeStartCuller(env) {
  const started = await env.KV.get("culler_started");
  if (!started) {
    console.log("Starting CullDO for first time");
    const id = env.CULLER.newUniqueId();
    const stub = env.CULLER.get(id);
    await stub.fetch("https://internal/start", { method: "POST" });
    await env.KV.put("culler_started", "1");
    console.log("CullDO started — running now then daily at 3 AM EST");
  }
}

// ---------------------------------------------------------------------------
// Main fetch handler
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/interactions") {
      const bodyText = await verifyDiscordSignature(request, env);
      if (!bodyText) return new Response("Unauthorized", { status: 401 });

      const interaction = JSON.parse(bodyText);
      if (interaction.type === 1) return Response.json({ type: 1 });

      if (interaction.type === 2) {
        const { name, options = [] } = interaction.data;
        const token = interaction.token;

        const response = new Response(JSON.stringify({ type: 5 }), {
          headers: { "Content-Type": "application/json" },
        });

        ctx.waitUntil((async () => {
          const devMode = false;
          let reply;
          if (name === "event") {
            reply = await handleEventCommand(env, options, devMode);
          } else if (name === "cancel") {
            reply = await handleCancelCommand(env, options, devMode);
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
        })());

        return response;
      }

      return Response.json({ type: 1 });
    }

    if (url.searchParams.get("token") !== TOKEN) {
      return new Response("Unauthorized", { status: 401 });
    }

    const devMode = url.searchParams.get("dev") === "1";

    await maybePostDocs(env, devMode);
    await maybePostGeneral(env, devMode);
    await maybeStartCuller(env);

    if (path === "/unloaded") {
      const doneMsgId = await env.KV.get("done_msg_id");
      if (doneMsgId) await deleteMessage(env, CHANNEL_ID, doneMsgId, devMode);
      const data = await sendMessage(env, CHANNEL_ID, `@everyone 🟩 The dishwasher is empty and ready to be loaded!`, devMode);
      await env.KV.put("empty_msg_id", data.id);
      await setChannelName(env, CHANNEL_ID, "🟩", "dishwasher-alerts", devMode);
      return new Response("Done!");
    }

    if (path === "/washer") {
      await maybePostLaundryIntro(env, devMode);
      const minutes = parseInt(url.searchParams.get("minutes") || "45");
      const startTs = Math.floor(Date.now() / 1000);
      const future = startTs + minutes * 60;
      const data = await sendMessage(env, LAUNDRY_CHANNEL_ID, `🫧 The washer is RUNNING. It will be done <t:${future}:R>`, devMode);
      await setChannelName(env, LAUNDRY_CHANNEL_ID, "🫧", "laundry-alerts", devMode);
      await scheduleTimer(env, "washer", minutes * 60 * 1000, { msgid: data.id, startTs, devMode });
      return new Response("Started!");
    }

    if (path === "/dryer") {
      await maybePostLaundryIntro(env, devMode);
      const minutes = parseInt(url.searchParams.get("minutes") || "45");
      const startTs = Math.floor(Date.now() / 1000);
      const future = startTs + minutes * 60;
      const data = await sendMessage(env, LAUNDRY_CHANNEL_ID, `🌀 The dryer is RUNNING. It will be done <t:${future}:R>`, devMode);
      await setChannelName(env, LAUNDRY_CHANNEL_ID, "🌀", "laundry-alerts", devMode);
      await scheduleTimer(env, "dryer", minutes * 60 * 1000, { msgid: data.id, startTs, devMode });
      return new Response("Started!");
    }

    if (path === "/arrived") {
      const personRaw = url.searchParams.get("person");
      if (!personRaw) return new Response("Missing person", { status: 400 });
      const person = PEOPLE[personRaw.toLowerCase()] ?? personRaw;
      const key = personRaw.toLowerCase();
      const ts = Math.floor(Date.now() / 1000);
      await env.KV.put(`status_${key}`, JSON.stringify({ type: "arrived", ts }));
      await maybePostLocationIntro(env, devMode);
      await sendMessage(env, LOCATION_CHANNEL_ID, `🏠 ${person} has arrived home! (@here)`, devMode);
      await setChannelName(env, LOCATION_CHANNEL_ID, "🏠", "leave-arrival-alerts", devMode);
      await updateStatusBoard(env, devMode);
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
      await maybePostLocationIntro(env, devMode);
      await sendMessage(env, LOCATION_CHANNEL_ID, message, devMode);
      await setChannelName(env, LOCATION_CHANNEL_ID, "🚶", "leave-arrival-alerts", devMode);
      await updateStatusBoard(env, devMode);
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
        mapsLink = `https://www.google.com/maps?q=${encodeURIComponent(address)}`;
        placeText = ` (${address})`;
      } else {
        mapsLink = `https://www.google.com/maps?q=${lat},${lon}`;
        const place = await reverseGeocode(env, lat, lon);
        placeText = place ? ` (${place})` : "";
      }

      await env.KV.put(`status_${key}`, JSON.stringify({
        type: "location", ts, mapsLink,
        place: placeText.replace(/[()]/g, "").trim(),
      }));
      await maybePostLocationIntro(env, devMode);
      await sendMessage(env, LOCATION_CHANNEL_ID, `🌐 ${person} is here!${placeText} ${mapsLink} (@here)`, devMode);
      await updateStatusBoard(env, devMode);
      return new Response("Done!");
    }

    // Default: dishwasher run
    const emptyMsgId = await env.KV.get("empty_msg_id");
    if (emptyMsgId) await deleteMessage(env, CHANNEL_ID, emptyMsgId, devMode);
    const doneMsgId = await env.KV.get("done_msg_id");
    if (doneMsgId) await deleteMessage(env, CHANNEL_ID, doneMsgId, devMode);
    await maybePostIntro(env, devMode);
    const minutes = parseInt(url.searchParams.get("minutes") || "150");
    const startTs = Math.floor(Date.now() / 1000);
    const future = startTs + minutes * 60;
    const data = await sendMessage(env, CHANNEL_ID, `@everyone 🔴 The dishwasher is RUNNING. It will be done <t:${future}:R>`, devMode);
    await env.KV.put("running_msg_id", data.id);
    await setChannelName(env, CHANNEL_ID, "🔴", "dishwasher-alerts", devMode);
    await scheduleTimer(env, "dishwasher", minutes * 60 * 1000, { msgid: data.id, startTs, devMode });
    return new Response("Started!");
  },
};
