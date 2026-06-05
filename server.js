import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const HOSTAWAY_ACCOUNT_ID = process.env.HOSTAWAY_ACCOUNT_ID;
const HOSTAWAY_API_KEY    = process.env.HOSTAWAY_API_KEY;
const PORT                = process.env.PORT || 3000;
const BASE_URL            = "https://api.hostaway.com/v1";

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
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000; // refresh 1 min early
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
const server = new McpServer({
  name: "hostaway-mcp",
  version: "1.0.0",
});

// ── TOOL: List Listings ───────────────────────────────────────────────────────
server.tool(
  "list_listings",
  "Get all property listings from your Hostaway account",
  {
    limit:  z.number().optional().describe("Max number of listings (default 50)"),
    offset: z.number().optional().describe("Pagination offset"),
  },
  async ({ limit = 50, offset = 0 }) => {
    const data = await hostawayFetch(`/listings?limit=${limit}&offset=${offset}`);
    const listings = data.result.map((l) => ({
      id:        l.id,
      name:      l.name,
      address:   l.address,
      bedrooms:  l.bedroomsNumber,
      bathrooms: l.bathroomsNumber,
      capacity:  l.personCapacity,
      status:    l.status,
    }));
    return {
      content: [{ type: "text", text: JSON.stringify({ total: data.count, listings }, null, 2) }],
    };
  }
);

// ── TOOL: Get Reservations ────────────────────────────────────────────────────
server.tool(
  "get_reservations",
  "Get reservations, optionally filtered by status or date range",
  {
    status:    z.enum(["new", "modified", "cancelled", "ownerStay", "inquiry", "tentative", "blocked"]).optional().describe("Filter by reservation status"),
    dateFrom:  z.string().optional().describe("Check-in from date (YYYY-MM-DD)"),
    dateTo:    z.string().optional().describe("Check-in to date (YYYY-MM-DD)"),
    listingId: z.number().optional().describe("Filter by listing ID"),
    limit:     z.number().optional().describe("Max results (default 20)"),
  },
  async ({ status, dateFrom, dateTo, listingId, limit = 20 }) => {
    const params = new URLSearchParams({ limit });
    if (status)    params.set("status", status);
    if (dateFrom)  params.set("startDate", dateFrom);
    if (dateTo)    params.set("endDate", dateTo);
    if (listingId) params.set("listingId", listingId);

    const data = await hostawayFetch(`/reservations?${params}`);
    const reservations = data.result.map((r) => ({
      id:           r.id,
      listingId:    r.listingMapId,
      guestName:    `${r.guestFirstName} ${r.guestLastName}`,
      checkIn:      r.arrivalDate,
      checkOut:     r.departureDate,
      status:       r.status,
      channel:      r.channelName,
      totalPrice:   r.totalPrice,
      currency:     r.currency,
      adults:       r.adults,
      children:     r.children,
    }));
    return {
      content: [{ type: "text", text: JSON.stringify({ total: data.count, reservations }, null, 2) }],
    };
  }
);

// ── TOOL: Get Reservation Detail ──────────────────────────────────────────────
server.tool(
  "get_reservation_detail",
  "Get full details for a specific reservation by ID",
  { reservationId: z.number().describe("The reservation ID") },
  async ({ reservationId }) => {
    const data = await hostawayFetch(`/reservations/${reservationId}`);
    return {
      content: [{ type: "text", text: JSON.stringify(data.result, null, 2) }],
    };
  }
);

// ── TOOL: Get Conversations / Messages ────────────────────────────────────────
server.tool(
  "get_conversations",
  "Get guest conversations/messages",
  {
    listingId:     z.number().optional().describe("Filter by listing ID"),
    reservationId: z.number().optional().describe("Filter by reservation ID"),
    limit:         z.number().optional().describe("Max results (default 20)"),
  },
  async ({ listingId, reservationId, limit = 20 }) => {
    const params = new URLSearchParams({ limit });
    if (listingId)     params.set("listingId", listingId);
    if (reservationId) params.set("reservationId", reservationId);

    const data = await hostawayFetch(`/conversations?${params}`);
    return {
      content: [{ type: "text", text: JSON.stringify(data.result, null, 2) }],
    };
  }
);

// ── TOOL: Send Message ────────────────────────────────────────────────────────
server.tool(
  "send_message",
  "Send a message to a guest in a conversation",
  {
    conversationId: z.number().describe("Conversation ID"),
    message:        z.string().describe("The message text to send"),
  },
  async ({ conversationId, message }) => {
    const data = await hostawayFetch(`/conversations/${conversationId}/messages`, {
      method: "POST",
      body: JSON.stringify({ body: message }),
    });
    return {
      content: [{ type: "text", text: `✅ Message sent! Message ID: ${data.result?.id}` }],
    };
  }
);

// ── TOOL: Get Calendar / Availability ─────────────────────────────────────────
server.tool(
  "get_calendar",
  "Get calendar availability for a listing",
  {
    listingId: z.number().describe("Listing ID"),
    startDate: z.string().describe("Start date (YYYY-MM-DD)"),
    endDate:   z.string().describe("End date (YYYY-MM-DD)"),
  },
  async ({ listingId, startDate, endDate }) => {
    const data = await hostawayFetch(
      `/listings/${listingId}/calendar?startDate=${startDate}&endDate=${endDate}`
    );
    return {
      content: [{ type: "text", text: JSON.stringify(data.result, null, 2) }],
    };
  }
);

// ── TOOL: Get Financial Report ─────────────────────────────────────────────────
server.tool(
  "get_financials",
  "Get revenue and financial summary for reservations in a date range",
  {
    dateFrom: z.string().describe("Start date (YYYY-MM-DD)"),
    dateTo:   z.string().describe("End date (YYYY-MM-DD)"),
    listingId: z.number().optional().describe("Filter by listing ID"),
  },
  async ({ dateFrom, dateTo, listingId }) => {
    const params = new URLSearchParams({ startDate: dateFrom, endDate: dateTo, limit: 100 });
    if (listingId) params.set("listingId", listingId);

    const data = await hostawayFetch(`/reservations?${params}`);
    const reservations = data.result.filter(r => r.status !== "cancelled");

    const summary = {
      period: { from: dateFrom, to: dateTo },
      totalReservations: reservations.length,
      totalRevenue: reservations.reduce((sum, r) => sum + (parseFloat(r.totalPrice) || 0), 0).toFixed(2),
      currency: reservations[0]?.currency || "USD",
      byChannel: {},
    };

    reservations.forEach(r => {
      if (!summary.byChannel[r.channelName]) summary.byChannel[r.channelName] = { count: 0, revenue: 0 };
      summary.byChannel[r.channelName].count++;
      summary.byChannel[r.channelName].revenue += parseFloat(r.totalPrice) || 0;
    });

    return {
      content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
    };
  }
);

// ─── EXPRESS APP ──────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// Simple API-key auth middleware (protect your MCP endpoint)
app.use((req, res, next) => {
  const key = req.headers["x-api-key"];
  if (process.env.MCP_API_KEY && key !== process.env.MCP_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// MCP endpoint
app.post("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get("/health", (_, res) => res.json({ status: "ok", server: "hostaway-mcp" }));

app.listen(PORT, () => {
  console.log(`\n🏠 Hostaway MCP Server running`);
  console.log(`   Local:  http://localhost:${PORT}/mcp`);
  console.log(`   Health: http://localhost:${PORT}/health\n`);
});
