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
const TRADES_CHANNEL_ID = "1507502258097754154";    // #trades
const DEV_CHANNEL_ID = "1497815253311029381";       // #bot-development-spam

const APP_ID = "1497846686624776363";
const API = "https://discord.com/api/v10";
const TZ = "America/New_York";
const GITHUB_URL = "https://github.com/mangoALCATRAZ/house-bot";

const SNAKE_USER_ID = "436947323445313536";
const SNAKE_EMAIL = "angeluccimatt4@gmail.com";
const RESEND_FROM = "onboarding@resend.dev";

const SCHWAB_BASE = "https://api.schwabapi.com";
const SCHWAB_AUTH_URL = "https://api.schwabapi.com/v1/oauth/authorize";
const SCHWAB_TOKEN_URL = "https://api.schwabapi.com/v1/oauth/token";
const SCHWAB_CALLBACK = "https://discord-shortcut.angeluccimatt4.workers.dev/schwab-callback";

const TRADE_POLL_INTERVAL_MS = 60 * 1000;
const MAX_CONVERSATION_TURNS = 10;

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
const TRADES_CULL_AGE_MS = 7 * 24 * 60 * 60 * 1000;
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
    await new Promise(resolve => setTimeout(resolve, data.retry_after * 1000));
    await fetch(`${API}/channels/${channelId}`, {
      method: "PATCH",
      headers: botHeaders(env),
      body: JSON.stringify({ name: `${emoji}${baseName}` }),
    });
  }
}

async function sendDM(env, content) {
  const dmRes = await fetch(`${API}/users/@me/channels`, {
    method: "POST",
    headers: botHeaders(env),
    body: JSON.stringify({ recipient_id: SNAKE_USER_ID }),
  });
  const dmChannel = await dmRes.json();
  if (!dmChannel.id) return;
  await fetch(`${API}/channels/${dmChannel.id}/messages`, {
    method: "POST",
    headers: botHeaders(env),
    body: JSON.stringify({ content }),
  });
}

// ---------------------------------------------------------------------------
// Email via Resend
// ---------------------------------------------------------------------------

async function sendEmail(env, subject, html) {
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: SNAKE_EMAIL,
      subject,
      html,
    }),
  });
}

// ---------------------------------------------------------------------------
// Claude helpers
// ---------------------------------------------------------------------------

function extractLinks(content) {
  const links = [];
  const seen = new Set();
  for (const block of content || []) {
    if (block.type === "tool_result") {
      for (const item of block.content || []) {
        if (item.type === "document" && item.source?.url && item.title) {
          const link = `[${item.title}](${item.source.url})`;
          if (!seen.has(item.source.url)) {
            seen.add(item.source.url);
            links.push(link);
          }
        }
      }
    }
    if (block.type === "web_search_tool_result") {
      for (const result of block.content || []) {
        if (result.url && result.title) {
          const link = `[${result.title}](${result.url})`;
          if (!seen.has(result.url)) {
            seen.add(result.url);
            links.push(link);
          }
        }
      }
    }
  }
  return links;
}

function buildClaudeResponse(data, maxLinks = 3) {
  const text = (data.content || [])
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("") || null;

  const links = extractLinks(data.content || []).slice(0, maxLinks);
  const linkSection = links.length > 0
    ? "\n\n📰 **Sources:**\n" + links.join("\n")
    : "";

  return text ? text + linkSection : null;
}

async function getTradeContext(env, symbol, action, quantity, price) {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": env.ANTHROPIC_API_KEY,
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{
          role: "user",
          content: `In 2-3 sentences, give brief context on this trade: ${action} ${quantity} shares of ${symbol} at $${price}. Search for recent news on ${symbol} to provide specific context on why this trade may have occurred. Be concise and factual. Do not give financial advice.`,
        }],
      }),
    });
    const data = await res.json();
    return buildClaudeResponse(data, 2);
  } catch (e) {
    console.error("Claude trade context error:", e);
    return null;
  }
}

// Gets portfolio analysis via parallel calls — one per ticker + one summary.
// Each call does only one search so they're fast, and Promise.all runs them simultaneously.
async function getPortfolioAnalysis(env, summary, period, topTickers = []) {
  try {
    const anthropicHeaders = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": env.ANTHROPIC_API_KEY,
    };

    // Fire all requests in parallel
    const [summaryRes, ...tickerRes] = await Promise.all([
      // Overall portfolio summary (no search needed, just text)
      fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: anthropicHeaders,
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 256,
          messages: [{
            role: "user",
            content: `In 2-3 sentences, summarize this portfolio activity. Be concise and factual.\n\n${summary}`,
          }],
        }),
      }),
      // One focused search call per ticker
      ...topTickers.map(ticker =>
        fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: anthropicHeaders,
          body: JSON.stringify({
            model: "claude-sonnet-4-6",
            max_tokens: 512,
            tools: [{ type: "web_search_20250305", name: "web_search" }],
            messages: [{
              role: "user",
              content: `Search for recent news on ${ticker} and give 1-2 bullet points of specific context. Be brief and factual. Do not give financial advice.`,
            }],
          }),
        })
      ),
    ]);

    // Parse all responses in parallel
    const [summaryData, ...tickerData] = await Promise.all([
      summaryRes.json(),
      ...tickerRes.map(r => r.json()),
    ]);

    const summaryText = buildClaudeResponse(summaryData, 0);
    const tickerSections = tickerData.map((data, i) => {
      const text = buildClaudeResponse(data, 2);
      return text ? `**${topTickers[i]}**\n${text}` : null;
    }).filter(Boolean);

    return [summaryText, ...tickerSections].filter(Boolean).join("\n\n---\n\n") || null;
  } catch (e) {
    console.error("Claude portfolio analysis error:", e);
    return null;
  }
}

async function askClaude(env, question) {
  const historyRaw = await env.KV.get("trades_conversation");
  let history = historyRaw ? JSON.parse(historyRaw) : [];

  if (history.length === 0) {
    const result = await buildPortfolioSummary(env, "Current");
    if (result) {
      history.push({
        role: "user",
        content: `Here is my current portfolio summary for context:\n\n${result.text}\n\nPlease acknowledge this so we can discuss it.`,
      });
      const primeRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": env.ANTHROPIC_API_KEY,
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 256,
          system: "You are a financial research assistant helping analyze a personal investment portfolio. Be concise, factual, and never give direct financial advice. You have access to web search to look up current news and data.",
          messages: history,
        }),
      });
      const primeData = await primeRes.json();
      const primeText = primeData.content?.filter(b => b.type === "text").map(b => b.text).join("") || "Got it.";
      history.push({ role: "assistant", content: primeText });
    }
  }

  history.push({ role: "user", content: question });

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": env.ANTHROPIC_API_KEY,
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      system: "You are a financial research assistant helping analyze a personal investment portfolio. Be concise, factual, and never give direct financial advice. You have access to web search to look up current news and data.",
      messages: history,
    }),
  });

  const data = await res.json();
  const reply = buildClaudeResponse(data, 3);

  if (reply) {
    const textOnly = (data.content || [])
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("");
    history.push({ role: "assistant", content: textOnly });

    const maxMessages = MAX_CONVERSATION_TURNS * 2 + 2;
    if (history.length > maxMessages) {
      history = history.slice(history.length - maxMessages);
    }

    await env.KV.put("trades_conversation", JSON.stringify(history));
  }

  return reply;
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
// Schwab OAuth helpers
// ---------------------------------------------------------------------------

function buildSchwabAuthUrl(env) {
  const params = new URLSearchParams({
    client_id: env.SCHWAB_CLIENT_ID,
    redirect_uri: SCHWAB_CALLBACK,
    response_type: "code",
    scope: "readonly",
  });
  return `${SCHWAB_AUTH_URL}?${params}`;
}

async function exchangeSchwabCode(env, code) {
  const credentials = btoa(`${env.SCHWAB_CLIENT_ID}:${env.SCHWAB_CLIENT_SECRET}`);
  const res = await fetch(SCHWAB_TOKEN_URL, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: SCHWAB_CALLBACK,
    }),
  });
  return res.json();
}

async function refreshSchwabToken(env) {
  const refreshToken = await env.KV.get("schwab_refresh_token");
  if (!refreshToken) throw new Error("No refresh token stored");
  const credentials = btoa(`${env.SCHWAB_CLIENT_ID}:${env.SCHWAB_CLIENT_SECRET}`);
  const res = await fetch(SCHWAB_TOKEN_URL, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  const data = await res.json();
  if (data.access_token) {
    await env.KV.put("schwab_access_token", data.access_token);
    await env.KV.put("schwab_token_expires_at", String(Date.now() + data.expires_in * 1000));
    if (data.refresh_token) await env.KV.put("schwab_refresh_token", data.refresh_token);
  }
  return data.access_token;
}

async function getSchwabToken(env) {
  const expiresAt = await env.KV.get("schwab_token_expires_at");
  const accessToken = await env.KV.get("schwab_access_token");
  if (!accessToken || !expiresAt || Date.now() > Number(expiresAt) - 5 * 60 * 1000) {
    return refreshSchwabToken(env);
  }
  return accessToken;
}

// ---------------------------------------------------------------------------
// Schwab API calls
// ---------------------------------------------------------------------------

async function getSchwabAccounts(env) {
  const token = await getSchwabToken(env);
  const res = await fetch(`${SCHWAB_BASE}/trader/v1/accounts/accountNumbers`, {
    headers: { "Authorization": `Bearer ${token}` },
  });
  return res.json();
}

async function getSchwabOrders(env, accountHash, fromDate, toDate) {
  const token = await getSchwabToken(env);
  const params = new URLSearchParams({
    fromEnteredTime: fromDate,
    toEnteredTime: toDate,
    status: "FILLED",
  });
  const res = await fetch(`${SCHWAB_BASE}/trader/v1/accounts/${accountHash}/orders?${params}`, {
    headers: { "Authorization": `Bearer ${token}` },
  });
  return res.json();
}

async function getSchwabPositions(env) {
  const token = await getSchwabToken(env);
  const res = await fetch(`${SCHWAB_BASE}/trader/v1/accounts?fields=positions`, {
    headers: { "Authorization": `Bearer ${token}` },
  });
  return res.json();
}

async function buildTradeEmbed(env, order) {
  const leg = order.orderLegCollection?.[0];
  if (!leg) return null;
  const symbol = leg.instrument?.symbol || "Unknown";
  const action = leg.instruction || "Unknown";
  const quantity = leg.quantity || 0;
  const price = order.price || order.filledPrice || 0;
  const orderType = order.orderType || "Unknown";
  const filledAt = order.closeTime || order.enteredTime;
  const actionEmoji = action.includes("BUY") ? "🟢" : "🔴";
  const ts = filledAt ? Math.floor(new Date(filledAt).getTime() / 1000) : null;

  const embed = {
    title: `${actionEmoji} ${action} — ${symbol}`,
    color: action.includes("BUY") ? 0x2ecc71 : 0xe74c3c,
    fields: [
      { name: "Quantity", value: `${quantity} shares`, inline: true },
      { name: "Price", value: `$${Number(price).toFixed(2)}`, inline: true },
      { name: "Total", value: `$${(quantity * price).toFixed(2)}`, inline: true },
      { name: "Order Type", value: orderType, inline: true },
    ],
  };
  if (ts) embed.fields.push({ name: "Filled", value: `<t:${ts}:F>`, inline: true });
  const context = await getTradeContext(env, symbol, action, quantity, price);
  if (context) embed.fields.push({ name: "🤖 Claude's Take", value: context, inline: false });
  return embed;
}

async function buildSummaryEmbeds(env, accounts, positions, period, analysis) {
  let totalValue = 0;
  let totalDayPL = 0;

  for (const account of accounts) {
    const acct = account.securitiesAccount;
    if (!acct) continue;
    totalValue += acct.currentBalances?.liquidationValue || 0;
    totalDayPL += acct.currentBalances?.dayProfitLoss || 0;
  }

  const plColor = totalDayPL >= 0 ? 0x2ecc71 : 0xe74c3c;
  const plSign = totalDayPL >= 0 ? "+" : "";

  const summaryEmbed = {
    title: `📊 ${period} Portfolio Summary`,
    color: plColor,
    timestamp: new Date().toISOString(),
    fields: [
      { name: "💰 Total Value", value: `$${totalValue.toFixed(2)}`, inline: true },
      { name: "📈 Day P&L", value: `${plSign}$${totalDayPL.toFixed(2)}`, inline: true },
      { name: "📦 Positions", value: `${positions.length} holdings`, inline: true },
      {
        name: "Holdings",
        value: positions.length > 0
          ? positions.map(p => {
              const s = p.dayPL >= 0 ? "+" : "";
              const e = p.dayPL >= 0 ? "🟢" : "🔴";
              const pct = Math.abs(p.dayPLPct) < 0.005
                ? p.dayPLPct.toFixed(4)
                : p.dayPLPct.toFixed(2);
              return `${e} **${p.symbol}** — ${p.quantity} shares | ${s}$${p.dayPL.toFixed(2)} (${pct}%)`;
            }).join("\n")
          : "No positions",
        inline: false,
      },
    ],
  };

  const embeds = [summaryEmbed];
  if (analysis) {
    embeds.push({
      description: `🤖 **Claude's Analysis**\n${analysis}`,
      color: 0x5865F2,
    });
  }

  return embeds;
}

async function buildPortfolioSummary(env, period) {
  const accounts = await getSchwabPositions(env);
  if (!Array.isArray(accounts)) return null;

  let totalValue = 0;
  let totalDayPL = 0;
  const positions = [];

  for (const account of accounts) {
    const acct = account.securitiesAccount;
    if (!acct) continue;
    totalValue += acct.currentBalances?.liquidationValue || 0;
    totalDayPL += acct.currentBalances?.dayProfitLoss || 0;
    for (const pos of acct.positions || []) {
      positions.push({
        symbol: pos.instrument?.symbol || "Unknown",
        quantity: pos.longQuantity || pos.shortQuantity || 0,
        marketValue: pos.marketValue || 0,
        dayPL: pos.currentDayProfitLoss || 0,
        dayPLPct: pos.currentDayProfitLossPercentage || 0,
      });
    }
  }

  positions.sort((a, b) => Math.abs(b.dayPL) - Math.abs(a.dayPL));

  const lines = [
    `Period: ${period}`,
    `Total Portfolio Value: $${totalValue.toFixed(2)}`,
    `Day P&L: ${totalDayPL >= 0 ? "+" : ""}$${totalDayPL.toFixed(2)}`,
    "",
    "Positions:",
    ...positions.map(p => {
      const pct = Math.abs(p.dayPLPct) < 0.005
        ? p.dayPLPct.toFixed(4)
        : p.dayPLPct.toFixed(2);
      return `  ${p.symbol}: ${p.quantity} shares | Day P&L: ${p.dayPL >= 0 ? "+" : ""}$${p.dayPL.toFixed(2)} (${pct}%)`;
    }),
  ];

  return { text: lines.join("\n"), accounts, totalValue, totalDayPL, positions };
}

function buildSummaryEmail(period, summary, analysis) {
  return `
    <html><body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
      <h2>📊 house-bot ${period} Portfolio Summary</h2>
      <pre style="background:#f5f5f5;padding:16px;border-radius:8px;font-size:13px;overflow-x:auto">${summary}</pre>
      ${analysis ? `<h3>🤖 Claude's Analysis</h3><p style="color:#333;line-height:1.6">${analysis}</p>` : ""}
      <hr style="margin-top:32px"/>
      <p style="color:#999;font-size:12px">house-bot — ${new Date().toLocaleDateString("en-US", { timeZone: TZ })}</p>
    </body></html>
  `;
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

function getNextMarketClose() {
  const now = new Date();
  const estNow = new Date(now.toLocaleString("en-US", { timeZone: TZ }));
  const next4PM = new Date(estNow);
  next4PM.setHours(16, 0, 0, 0);
  if (estNow >= next4PM) next4PM.setDate(next4PM.getDate() + 1);
  const tzOffset =
    new Date(next4PM.toLocaleString("en-US", { timeZone: "UTC" })) -
    new Date(next4PM.toLocaleString("en-US", { timeZone: TZ }));
  return next4PM.getTime() + tzOffset;
}

function isFriday() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: TZ })).getDay() === 5;
}

async function getPinnedIds(env, channelId) {
  const res = await fetch(`${API}/channels/${channelId}/pins`, { headers: botHeaders(env) });
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
    "raw", hexToBytes(env.DISCORD_PUBLIC_KEY),
    { name: "Ed25519", namedCurve: "Ed25519" }, false, ["verify"]
  );
  const valid = await crypto.subtle.verify(
    { name: "Ed25519" }, key, hexToBytes(signature),
    new TextEncoder().encode(timestamp + body)
  );
  return valid ? body : false;
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return bytes;
}

// ---------------------------------------------------------------------------
// Calendar helpers
// ---------------------------------------------------------------------------

function parseEventTime(date, time) {
  const naive = new Date(`${date}T${time}:00`);
  const utcStr = naive.toLocaleString("en-US", { timeZone: "UTC" });
  const estStr = naive.toLocaleString("en-US", { timeZone: TZ });
  return new Date(naive.getTime() + (new Date(utcStr) - new Date(estStr)));
}

function toMinutes(value, unit) {
  switch (unit) {
    case "hours": return value * 60;
    case "days": return value * 60 * 24;
    case "weeks": return value * 60 * 24 * 7;
    default: return value;
  }
}

function reminderLabel(value, unit) {
  const s = value === 1;
  switch (unit) {
    case "hours": return `${value} ${s ? "hour" : "hours"}`;
    case "days": return `${value} ${s ? "day" : "days"}`;
    case "weeks": return `${value} ${s ? "week" : "weeks"}`;
    default: return `${value} ${s ? "minute" : "minutes"}`;
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
  if (event.image) embed.image = { url: event.image };
  return embed;
}

async function updateCalendarBoard(env, devMode = false) {
  const calMsgId = await env.KV.get("calendar_msg_id");
  if (!calMsgId) return;
  const events = await pruneExpiredEvents(env);
  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  if (sorted.length === 0) {
    await editEmbeds(env, CALENDAR_CHANNEL_ID, calMsgId, "📅 **Upcoming Events**\n\nNo upcoming events.", [], devMode);
  } else {
    await editEmbeds(env, CALENDAR_CHANNEL_ID, calMsgId, "📅 **Upcoming Events**", sorted.slice(0, 10).map(buildEventEmbed), devMode);
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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "❌ Date must be YYYY-MM-DD.";
  if (!/^\d{2}:\d{2}$/.test(time)) return "❌ Time must be HH:MM (24h EST).";

  const eventTs = parseEventTime(date, time).getTime();
  const now = Date.now();
  if (eventTs <= now) return "❌ Event date is in the past.";

  await maybePostCalendarIntro(env, devMode);

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
    await scheduleTimer(env, "event_reminder", reminderDelay, { eventId: id, eventTitle: title, eventTs, devMode });
  }
  await scheduleTimer(env, "event_expire", eventTs - now + 60000, { eventId: id, devMode });

  await sendMessage(env, CALENDAR_CHANNEL_ID,
    `@here 📅 New event added: **${title}** — <t:${Math.floor(eventTs / 1000)}:F> 🔔 Reminder ${label} before. 🆔 \`${id}\``, devMode);

  return `✅ Event **${title}** added for <t:${Math.floor(eventTs / 1000)}:F>! Reminder: ${label} before. ID: \`${id}\``;
}

async function handleCancelCommand(env, options, devMode) {
  const id = options.find(o => o.name === "id")?.value;
  if (!id) return "❌ Missing event ID.";
  const events = await getEvents(env);
  const idx = events.findIndex(e => e.id === id);
  if (idx === -1) return "❌ Event not found.";
  const [removed] = events.splice(idx, 1);
  await saveEvents(env, events);
  await updateCalendarBoard(env, devMode);
  await sendMessage(env, CALENDAR_CHANNEL_ID,
    `@here ❌ Event cancelled: **${removed.title}** (<t:${Math.floor(removed.ts / 1000)}:F>)`, devMode);
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

async function handleSummaryCommand(env) {
  const hasToken = await env.KV.get("schwab_access_token");
  if (!hasToken) return "❌ Schwab not connected. Authorize at `/schwab-auth` first.";

  const result = await buildPortfolioSummary(env, "On-Demand");
  if (!result) return "❌ Could not fetch portfolio data from Schwab.";

  const topTickers = result.positions.slice(0, 3).map(p => p.symbol);
  const analysis = await getPortfolioAnalysis(env, result.text, "on-demand", topTickers);
  const embeds = await buildSummaryEmbeds(env, result.accounts, result.positions, "On-Demand", analysis);
  await sendEmbeds(env, TRADES_CHANNEL_ID, "", embeds);
  return "✅ Summary posted to #trades.";
}

async function handleAskCommand(env, options) {
  const question = options.find(o => o.name === "question")?.value;
  if (!question) return "❌ Missing question.";

  if (question.toLowerCase().trim() === "clear") {
    await env.KV.delete("trades_conversation");
    return "🗑️ Conversation cleared. Next `/ask` will start fresh with your current portfolio.";
  }

  const hasToken = await env.KV.get("schwab_access_token");
  if (!hasToken) return "❌ Schwab not connected. Authorize at `/schwab-auth` first.";

  try {
    const reply = await askClaude(env, question);
    if (!reply) return "❌ No response from Claude. Try again.";

    if (reply.length <= 1900) {
      await sendMessage(env, TRADES_CHANNEL_ID, `🤖 **Claude:** ${reply}`);
    } else {
      const chunks = reply.match(/.{1,1900}/gs) || [];
      for (let i = 0; i < chunks.length; i++) {
        const prefix = i === 0 ? "🤖 **Claude:** " : "";
        await sendMessage(env, TRADES_CHANNEL_ID, `${prefix}${chunks[i]}`);
      }
    }

    const history = JSON.parse(await env.KV.get("trades_conversation") || "[]");
    const turns = Math.floor((history.length - 2) / 2);
    return `✅ Response posted to #trades. (${turns}/${MAX_CONVERSATION_TURNS} turns used — say \`clear\` to reset)`;
  } catch (e) {
    console.error("Ask Claude error:", e);
    return "❌ Error talking to Claude. Try again.";
  }
}

// ---------------------------------------------------------------------------
// Status board
// ---------------------------------------------------------------------------

async function buildStatusBoard(env) {
  const lines = ["📊 **Current Status**"];
  for (const key of Object.keys(PEOPLE)) {
    const raw = await env.KV.get(`status_${key}`);
    if (!raw) { lines.push(`❓ **${key}** — Unknown`); continue; }
    const status = JSON.parse(raw);
    const ts = `<t:${status.ts}:R>`;
    if (status.type === "arrived") lines.push(`🏠 **${key}** — Home (${ts})`);
    else if (status.type === "left") {
      const dest = status.destination ? ` — headed to ${status.destination}` : "";
      lines.push(`🚶 **${key}** — Out${dest} (${ts})`);
    } else if (status.type === "location") {
      const place = status.place ? ` (${status.place})` : "";
      lines.push(`🌐 **${key}** — Last seen [here](${status.mapsLink})${place} (${ts})`);
    }
  }
  lines.push("​", "​");
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
      "​",
      "🍽️ **#dishwasher-alerts** — Dishwasher status.",
      "👕 **#laundry-alerts** — Washer and dryer status.",
      "🏠 **#leave-arrival-alerts** — Who's home.",
      "📅 **#calendar** — Shared house calendar.",
      "📈 **#trades** — Snake's live trade alerts and portfolio summaries.",
      "📖 **#bot-api-documentation** — Full API docs.",
      "​", "​",
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
      "> All endpoints require `?token=TOKEN`. Add `&dev=1` to test in #bot-development-spam.",
      "",
      "## 🍽️ Dishwasher",
      "**`GET /`** — Start cycle (`minutes`, default 150)",
      "**`GET /unloaded`** — Mark empty",
      "",
      "## 👕 Laundry",
      "**`GET /washer`** — Start washer (`minutes`, default 45)",
      "**`GET /dryer`** — Start dryer (`minutes`, default 45)",
      "",
      "## 📅 Calendar",
      "`/event title date time [reminder] [reminder_unit] [image] [location_name] [location_url]`",
      "- reminder_unit: minutes (default), hours, days, weeks",
      "`/cancel id` · `/events`",
      "",
      "## 🏠 Leave/Arrival",
      "**`GET /arrived`** — `person` required",
      "**`GET /left`** — `person` required, `destination` optional",
      "**`GET /location`** — `person` + `lat`/`lon` or `address`",
      "",
      "## 📈 Trades (Snake only)",
      "**`GET /schwab-auth`** — Start Schwab OAuth",
      "`/summary` — On-demand portfolio summary",
      "`/ask question:...` — Chat with Claude about your portfolio (multi-turn)",
      "`/ask question:clear` — Reset conversation",
      "Trades polled every minute. Daily summary 4 PM EST. Weekly summary Fridays.",
      "",
      "## 👤 People",
      "snake · floogin · toad",
      "",
      "## 🧹 Cull",
      "Daily at 3 AM EST. Most channels: 2 days. #trades: 7 days. Pinned always preserved.",
      "",
      `📖 <${GITHUB_URL}>`,
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
      "​",
      "🔴 Running · 🏁 Done · 🟩 Empty",
      "​", "​",
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
      "​",
      "🏠 Arrived · 🚶 Left · 🌐 Location",
      "​", "​",
    ].join("\n"), devMode);
    await pinMessage(env, LOCATION_CHANNEL_ID, intro.id, devMode);
    const statusMsg = await sendMessage(env, LOCATION_CHANNEL_ID, await buildStatusBoard(env), devMode);
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
      "​",
      "🫧 Washer Running · ⚠️ Washer Done · 🌀 Dryer Running · ✅ Dryer Done",
      "​", "​",
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
        "​",
        "📌 `/event title:Dentist date:2026-05-01 time:14:00 reminder:1 reminder_unit:days`",
        "❌ `/cancel id:evt_abc123`  📋 `/events`",
        "​",
        "Times in EST. reminder_unit: minutes (default), hours, days, weeks.",
        "​", "​",
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

async function maybePostTradesIntro(env, devMode) {
  const posted = await env.KV.get("trades_intro_posted");
  if (posted) return;
  const data = await sendMessage(env, TRADES_CHANNEL_ID, [
    "📈 **Welcome to #trades!**",
    "Live trade alerts from Snake's Schwab account. Daily summaries at 4 PM EST. Weekly summaries Fridays.",
    "Use `/summary` for an on-demand snapshot. Use `/ask` to chat with Claude about your portfolio.",
    "​", "​",
  ].join("\n"), devMode);
  await pinMessage(env, TRADES_CHANNEL_ID, data.id, devMode);
  await env.KV.put("trades_intro_posted", "1");
}

// ---------------------------------------------------------------------------
// Durable Objects
// ---------------------------------------------------------------------------

export class CullDO extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.ctx = ctx; this.env = env; }
  async fetch(request) {
    await this.alarm();
    await this.ctx.storage.setAlarm(getNext3AMEST());
    return new Response("Culler started");
  }
  async alarm() {
    for (const channelId of CULL_CHANNELS) {
      try { await cullChannel(this.env, channelId, CULL_AGE_MS); }
      catch (e) { console.error(`Cull failed for ${channelId}:`, e); }
    }
    try { await cullChannel(this.env, TRADES_CHANNEL_ID, TRADES_CULL_AGE_MS); }
    catch (e) { console.error("Trades cull failed:", e); }
    await this.ctx.storage.setAlarm(getNext3AMEST());
  }
}

export class TradePollDO extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.ctx = ctx; this.env = env; }
  async fetch(request) {
    await this.alarm();
    await this.ctx.storage.setAlarm(Date.now() + TRADE_POLL_INTERVAL_MS);
    return new Response("Trade poller started");
  }
  async alarm() {
    try { await pollTrades(this.env); }
    catch (e) { console.error("Trade poll error:", e); }
    await this.ctx.storage.setAlarm(Date.now() + TRADE_POLL_INTERVAL_MS);
  }
}

export class SummaryDO extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.ctx = ctx; this.env = env; }
  async fetch(request) {
    await this.alarm();
    await this.ctx.storage.setAlarm(getNextMarketClose());
    return new Response("Summary scheduler started");
  }
  async alarm() {
    const env = this.env;
    try {
      const period = isFriday() ? "Weekly" : "Daily";
      const result = await buildPortfolioSummary(env, period);
      if (!result) { await this.ctx.storage.setAlarm(getNextMarketClose()); return; }
      const topTickers = result.positions.slice(0, 3).map(p => p.symbol);
      const analysis = await getPortfolioAnalysis(env, result.text, period, topTickers);
      const embeds = await buildSummaryEmbeds(env, result.accounts, result.positions, period, analysis);
      await sendEmbeds(env, TRADES_CHANNEL_ID, "", embeds);
      await sendEmail(env, `house-bot ${period} Portfolio Summary`, buildSummaryEmail(period, result.text, analysis));
    } catch (e) { console.error("Summary error:", e); }
    await this.ctx.storage.setAlarm(getNextMarketClose());
  }
}

export class TimerDO extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.ctx = ctx; this.env = env; }
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
      if (events.find(e => e.id === eventId)) {
        await sendMessage(env, CALENDAR_CHANNEL_ID, `@everyone 🔔 Reminder: **${eventTitle}** is starting <t:${Math.floor(eventTs / 1000)}:R>!`, devMode);
      }
    } else if (type === "event_expire") {
      await pruneExpiredEvents(env);
      await updateCalendarBoard(env, devMode);
    } else if (type === "schwab_token_expiry_reminder") {
      const authUrl = `https://discord-shortcut.angeluccimatt4.workers.dev/schwab-auth?token=${TOKEN}`;
      await sendDM(env, `🔑 **Schwab token expiring tomorrow!** Re-authorize to keep trade alerts running:\n${authUrl}`);
    }

    await this.ctx.storage.delete("params");
  }
}

// ---------------------------------------------------------------------------
// Trade polling
// ---------------------------------------------------------------------------

async function pollTrades(env) {
  const accountsData = await getSchwabAccounts(env);
  if (!Array.isArray(accountsData)) return;

  const now = new Date();
  const fromDate = new Date(now.getTime() - 2 * 60 * 1000).toISOString();
  const toDate = now.toISOString();

  const lastSeenRaw = await env.KV.get("schwab_last_seen_orders");
  const lastSeen = lastSeenRaw ? JSON.parse(lastSeenRaw) : [];
  const newSeen = [...lastSeen];

  for (const account of accountsData) {
    const hash = account.hashValue;
    if (!hash) continue;
    const orders = await getSchwabOrders(env, hash, fromDate, toDate);
    if (!Array.isArray(orders)) continue;
    for (const order of orders) {
      if (lastSeen.includes(order.orderId)) continue;
      newSeen.push(order.orderId);
      const embed = await buildTradeEmbed(env, order);
      if (embed) await sendEmbeds(env, TRADES_CHANNEL_ID, "", [embed]);
    }
  }

  await env.KV.put("schwab_last_seen_orders", JSON.stringify(newSeen.slice(-200)));
}

// ---------------------------------------------------------------------------
// Scheduler helpers
// ---------------------------------------------------------------------------

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
    const id = env.CULLER.newUniqueId();
    await env.CULLER.get(id).fetch("https://internal/start", { method: "POST" });
    await env.KV.put("culler_started", "1");
  }
}

async function maybeStartTradePoller(env) {
  const started = await env.KV.get("trade_poller_started");
  const hasToken = await env.KV.get("schwab_access_token");
  if (!started && hasToken) {
    const id = env.TRADE_POLLER.newUniqueId();
    await env.TRADE_POLLER.get(id).fetch("https://internal/start", { method: "POST" });
    await env.KV.put("trade_poller_started", "1");
  }
}

async function maybeStartSummaryScheduler(env) {
  const started = await env.KV.get("summary_scheduler_started");
  const hasToken = await env.KV.get("schwab_access_token");
  if (!started && hasToken) {
    const id = env.SUMMARY_DO.newUniqueId();
    await env.SUMMARY_DO.get(id).fetch("https://internal/start", { method: "POST" });
    await env.KV.put("summary_scheduler_started", "1");
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
          let reply;
          if (name === "event") reply = await handleEventCommand(env, options, false);
          else if (name === "cancel") reply = await handleCancelCommand(env, options, false);
          else if (name === "events") reply = await handleEventsCommand(env);
          else if (name === "summary") reply = await handleSummaryCommand(env);
          else if (name === "ask") reply = await handleAskCommand(env, options);
          else reply = "Unknown command.";
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

    if (path === "/schwab-auth") {
      if (url.searchParams.get("token") !== TOKEN) return new Response("Unauthorized", { status: 401 });
      return Response.redirect(buildSchwabAuthUrl(env), 302);
    }

    if (path === "/schwab-callback") {
      const code = url.searchParams.get("code");
      if (!code) return new Response("Missing code", { status: 400 });
      const tokens = await exchangeSchwabCode(env, code);
      if (!tokens.access_token) return new Response("Token exchange failed", { status: 500 });

      await env.KV.put("schwab_access_token", tokens.access_token);
      await env.KV.put("schwab_refresh_token", tokens.refresh_token);
      await env.KV.put("schwab_token_expires_at", String(Date.now() + tokens.expires_in * 1000));
      await scheduleTimer(env, "schwab_token_expiry_reminder", 6 * 24 * 60 * 60 * 1000, {});

      await env.KV.delete("trade_poller_started");
      await env.KV.delete("summary_scheduler_started");
      await maybeStartTradePoller(env);
      await maybeStartSummaryScheduler(env);
      await maybePostTradesIntro(env, false);
      await sendDM(env, "✅ Schwab connected! Trade alerts and portfolio summaries are now active.");

      return new Response(`
        <html><body style="font-family:sans-serif;text-align:center;padding:40px">
          <h2>✅ Schwab Connected!</h2>
          <p>Trade alerts are now active. You can close this tab.</p>
        </body></html>
      `, { headers: { "Content-Type": "text/html" } });
    }

    if (url.searchParams.get("token") !== TOKEN) return new Response("Unauthorized", { status: 401 });

    const devMode = url.searchParams.get("dev") === "1";

    await maybePostDocs(env, devMode);
    await maybePostGeneral(env, devMode);
    await maybeStartCuller(env);
    await maybeStartTradePoller(env);
    await maybeStartSummaryScheduler(env);

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
      const data = await sendMessage(env, LAUNDRY_CHANNEL_ID, `🫧 The washer is RUNNING. It will be done <t:${startTs + minutes * 60}:R>`, devMode);
      await setChannelName(env, LAUNDRY_CHANNEL_ID, "🫧", "laundry-alerts", devMode);
      await scheduleTimer(env, "washer", minutes * 60 * 1000, { msgid: data.id, startTs, devMode });
      return new Response("Started!");
    }

    if (path === "/dryer") {
      await maybePostLaundryIntro(env, devMode);
      const minutes = parseInt(url.searchParams.get("minutes") || "45");
      const startTs = Math.floor(Date.now() / 1000);
      const data = await sendMessage(env, LAUNDRY_CHANNEL_ID, `🌀 The dryer is RUNNING. It will be done <t:${startTs + minutes * 60}:R>`, devMode);
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
      await env.KV.put(`status_${key}`, JSON.stringify({ type: "location", ts, mapsLink, place: placeText.replace(/[()]/g, "").trim() }));
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
    const data = await sendMessage(env, CHANNEL_ID, `@everyone 🔴 The dishwasher is RUNNING. It will be done <t:${startTs + minutes * 60}:R>`, devMode);
    await env.KV.put("running_msg_id", data.id);
    await setChannelName(env, CHANNEL_ID, "🔴", "dishwasher-alerts", devMode);
    await scheduleTimer(env, "dishwasher", minutes * 60 * 1000, { msgid: data.id, startTs, devMode });
    return new Response("Started!");
  },
};
