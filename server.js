import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const HOSTAWAY_ACCOUNT_ID = process.env.HOSTAWAY_ACCOUNT_ID;
const HOSTAWAY_API_KEY    = process.env.HOSTAWAY_API_KEY;
const PORT                = process.env.PORT || 3000;
const BASE_URL            = "https://api.hostaway.com/v1";
const SERVER_URL          = process.env.SERVER_URL || `http://localhost:${PORT}`;

if (!HOSTAWAY_ACCOUNT_ID || !HOSTAWAY_API_KEY) {
  console.error("❌  Set HOSTAWAY_ACCOUNT_ID and HOSTAWAY_API_KEY env vars first.");
  process.exit(1);
}

// ─── HOSTAWAY AUTH ────────────────────────────────────────────────────────────
let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const res = await fetch(`${BASE_URL}/accessTokens`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type:    "client_credentials",
      client_id:     HOSTAWAY_ACCOUNT_ID,
      client_secret: HOSTAWAY_API_KEY,
      scope:         "general",
    }),
  });
  if (!res.ok) throw new Error(`Auth failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

async function hostawayFetch(path, options = {}) {
  const token = await getAccessToken();
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.message || `API error ${res.status}`);
  return json;
}

// ─── MCP SERVER ───────────────────────────────────────────────────────────────
const server = new McpServer({ name: "hostaway-mcp", version: "1.0.0" });

server.tool("list_listings", "Get all property listings from your Hostaway account",
  { limit: z.number().optional(), offset: z.number().optional() },
  async ({ limit = 50, offset = 0 }) => {
    const data = await hostawayFetch(`/listings?limit=${limit}&offset=${offset}`);
    const listings = data.result.map((l) => ({
      id: l.id, name: l.name, address: l.address,
      bedrooms: l.bedroomsNumber, bathrooms: l.bathroomsNumber,
      capacity: l.personCapacity, status: l.status,
    }));
    return { content: [{ type: "text", text: JSON.stringify({ total: data.count, listings }, null, 2) }] };
  }
);

server.tool("get_reservations", "Get reservations, optionally filtered by status or date range",
  {
    status: z.enum(["new","modified","cancelled","ownerStay","inquiry","tentative","blocked"]).optional(),
    dateFrom: z.string().optional(), dateTo: z.string().optional(),
    listingId: z.number().optional(), limit: z.number().optional(),
  },
  async ({ status, dateFrom, dateTo, listingId, limit = 20 }) => {
    const params = new URLSearchParams({ limit });
    if (status) params.set("status", status);
    if (dateFrom) params.set("startDate", dateFrom);
    if (dateTo) params.set("endDate", dateTo);
    if (listingId) params.set("listingId", listingId);
    const data = await hostawayFetch(`/reservations?${params}`);
    const reservations = data.result.map((r) => ({
      id: r.id, listingId: r.listingMapId,
      guestName: `${r.guestFirstName} ${r.guestLastName}`,
      checkIn: r.arrivalDate, checkOut: r.departureDate,
      status: r.status, channel: r.channelName,
      totalPrice: r.totalPrice, currency: r.currency,
    }));
    return { content: [{ type: "text", text: JSON.stringify({ total: data.count, reservations }, null, 2) }] };
  }
);

server.tool("get_reservation_detail", "Get full details for a specific reservation",
  { reservationId: z.number() },
  async ({ reservationId }) => {
    const data = await hostawayFetch(`/reservations/${reservationId}`);
    return { content: [{ type: "text", text: JSON.stringify(data.result, null, 2) }] };
  }
);

server.tool("get_conversations", "Get guest conversations and messages",
  { listingId: z.number().optional(), reservationId: z.number().optional(), limit: z.number().optional() },
  async ({ listingId, reservationId, limit = 20 }) => {
    const params = new URLSearchParams({ limit });
    if (listingId) params.set("listingId", listingId);
    if (reservationId) params.set("reservationId", reservationId);
    const data = await hostawayFetch(`/conversations?${params}`);
    return { content: [{ type: "text", text: JSON.stringify(data.result, null, 2) }] };
  }
);

server.tool("send_message", "Send a message to a guest",
  { conversationId: z.number(), message: z.string() },
  async ({ conversationId, message }) => {
    const data = await hostawayFetch(`/conversations/${conversationId}/messages`, {
      method: "POST", body: JSON.stringify({ body: message }),
    });
    return { content: [{ type: "text", text: `✅ Message sent! ID: ${data.result?.id}` }] };
  }
);

server.tool("get_calendar", "Get calendar availability for a listing",
  { listingId: z.number(), startDate: z.string(), endDate: z.string() },
  async ({ listingId, startDate, endDate }) => {
    const data = await hostawayFetch(`/listings/${listingId}/calendar?startDate=${startDate}&endDate=${endDate}`);
    return { content: [{ type: "text", text: JSON.stringify(data.result, null, 2) }] };
  }
);

server.tool("get_financials", "Get revenue summary for a date range",
  { dateFrom: z.string(), dateTo: z.string(), listingId: z.number().optional() },
  async ({ dateFrom, dateTo, listingId }) => {
    const params = new URLSearchParams({ startDate: dateFrom, endDate: dateTo, limit: 100 });
    if (listingId) params.set("listingId", listingId);
    const data = await hostawayFetch(`/reservations?${params}`);
    const reservations = data.result.filter(r => r.status !== "cancelled");
    const summary = {
      period: { from: dateFrom, to: dateTo },
      totalReservations: reservations.length,
      totalRevenue: reservations.reduce((sum, r) => sum + (parseFloat(r.totalPrice) || 0), 0).toFixed(2),
      byChannel: {},
    };
    reservations.forEach(r => {
      if (!summary.byChannel[r.channelName]) summary.byChannel[r.channelName] = { count: 0, revenue: 0 };
      summary.byChannel[r.channelName].count++;
      summary.byChannel[r.channelName].revenue += parseFloat(r.totalPrice) || 0;
    });
    return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
  }
);

// ─── EXPRESS APP ──────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ─── OAUTH METADATA (required by Claude) ─────────────────────────────────────
app.get("/.well-known/oauth-authorization-server", (req, res) => {
  res.json({
    issuer: SERVER_URL,
    authorization_endpoint: `${SERVER_URL}/oauth/authorize`,
    token_endpoint: `${SERVER_URL}/oauth/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
  });
});

// OAuth authorize — just auto-approve and redirect back
app.get("/oauth/authorize", (req, res) => {
  const { redirect_uri, state, code_challenge } = req.query;
  const code = "hostaway-auth-code-" + Date.now();
  const url = new URL(redirect_uri);
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  res.redirect(url.toString());
});

// OAuth token — return a static token
app.post("/oauth/token", (req, res) => {
  res.json({
    access_token: "hostaway-mcp-token-" + Date.now(),
    token_type: "bearer",
    expires_in: 86400,
  });
});

// ─── MCP ENDPOINT ─────────────────────────────────────────────────────────────
app.post("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get("/health", (_, res) => res.json({ status: "ok", server: "hostaway-mcp" }));

app.listen(PORT, () => {
  console.log(`\n🏠 Hostaway MCP Server running on port ${PORT}`);
  console.log(`   MCP:    ${SERVER_URL}/mcp`);
  console.log(`   Health: ${SERVER_URL}/health\n`);
});
