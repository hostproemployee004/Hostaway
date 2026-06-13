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
  console.error("Set HOSTAWAY_ACCOUNT_ID and HOSTAWAY_API_KEY env vars.");
  process.exit(1);
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────
let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const res = await fetch(`${BASE_URL}/accessTokens`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: HOSTAWAY_ACCOUNT_ID,
      client_secret: HOSTAWAY_API_KEY,
      scope: "general",
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

// ─── FETCH ALL (auto-paginate) ────────────────────────────────────────────────
// Fetches every page until all records are retrieved.
// Pass filterFn to filter records on each page (saves memory).
async function fetchAll(endpoint, extraParams = {}, filterFn = null) {
  const BATCH = 100;
  let offset  = 0;
  let total   = null;
  let all     = [];

  while (true) {
    const params = new URLSearchParams({ limit: BATCH, offset, ...extraParams });
    const data   = await hostawayFetch(`${endpoint}?${params}`);
    total        = data.count;

    const batch = data.result || [];
    if (!batch.length) break;

    const keep = filterFn ? batch.filter(filterFn) : batch;
    all.push(...keep);

    offset += BATCH;
    if (offset >= total) break;
  }

  return { total, records: all };
}

// ─── DATE HELPERS ─────────────────────────────────────────────────────────────
function dateFilter(dateFrom, dateTo) {
  const from = dateFrom ? new Date(dateFrom) : null;
  const to   = dateTo   ? new Date(dateTo + "T23:59:59Z") : null;
  return (val) => {
    if (!val) return false;
    const d = new Date(val);
    if (from && d < from) return false;
    if (to   && d > to)   return false;
    return true;
  };
}

// ─── MCP SERVER ───────────────────────────────────────────────────────────────
const server = new McpServer({ name: "hostaway-mcp", version: "1.0.0" });

// ── LIST LISTINGS ─────────────────────────────────────────────────────────────
server.tool("list_listings",
  "Get ALL property listings. Fetches every page automatically.",
  { status: z.enum(["active","inactive"]).optional() },
  async ({ status }) => {
    const params = {};
    if (status) params.status = status;

    const { total, records } = await fetchAll("/listings", params);
    const listings = records.map(l => ({
      id:        l.id,
      name:      l.name,
      address:   l.address,
      bedrooms:  l.bedroomsNumber,
      bathrooms: l.bathroomsNumber,
      capacity:  l.personCapacity,
      status:    l.status,
    }));

    return { content: [{ type: "text", text: JSON.stringify({ totalInHostaway: total, returned: listings.length, listings }, null, 2) }] };
  }
);

// ── GET RESERVATIONS ──────────────────────────────────────────────────────────
server.tool("get_reservations",
  "Get ALL reservations for a date range. Automatically fetches every page so no data is missed. Use checkInFrom/checkInTo for arrival dates.",
  {
    checkInFrom:  z.string().optional().describe("Check-in from date YYYY-MM-DD"),
    checkInTo:    z.string().optional().describe("Check-in to date YYYY-MM-DD"),
    checkOutFrom: z.string().optional().describe("Check-out from date YYYY-MM-DD"),
    checkOutTo:   z.string().optional().describe("Check-out to date YYYY-MM-DD"),
    bookedFrom:   z.string().optional().describe("Booking created from date YYYY-MM-DD"),
    bookedTo:     z.string().optional().describe("Booking created to date YYYY-MM-DD"),
    status:       z.enum(["new","modified","cancelled","ownerStay","inquiry","tentative","blocked"]).optional(),
    channelName:  z.string().optional().describe("Filter by channel e.g. airbnb"),
    listingId:    z.number().optional().describe("Filter by listing ID"),
  },
  async ({ checkInFrom, checkInTo, checkOutFrom, checkOutTo, bookedFrom, bookedTo, status, channelName, listingId }) => {
    const params = {};
    if (status)      params.status      = status;
    if (listingId)   params.listingId   = listingId;
    if (checkInFrom) params.startDate   = checkInFrom;
    if (checkInTo)   params.endDate     = checkInTo;
    if (bookedFrom)  params.createdAfter  = bookedFrom;
    if (bookedTo)    params.createdBefore = bookedTo;

    // Client-side checkout filter
    const checkOutFilter = (checkOutFrom || checkOutTo)
      ? dateFilter(checkOutFrom, checkOutTo)
      : null;
    const channelFilter = channelName
      ? (r) => r.channelName?.toLowerCase().includes(channelName.toLowerCase())
      : null;

    const { total, records } = await fetchAll("/reservations", params, (r) => {
      if (checkOutFilter && !checkOutFilter(r.departureDate)) return false;
      if (channelFilter  && !channelFilter(r)) return false;
      return true;
    });

    const reservations = records.map(r => ({
      id:          r.id,
      listingId:   r.listingMapId,
      listingName: r.listingName,
      guestName:   `${r.guestFirstName} ${r.guestLastName}`,
      guestEmail:  r.guestEmail,
      checkIn:     r.arrivalDate,
      checkOut:    r.departureDate,
      bookedOn:    r.insertedOn,
      nights:      r.nights,
      guests:      (r.adults || 0) + (r.children || 0),
      status:      r.status,
      channel:     r.channelName,
      totalPrice:  r.totalPrice,
      currency:    r.currency,
    }));

    return { content: [{ type: "text", text: JSON.stringify({ totalInHostaway: total, returned: reservations.length, reservations }, null, 2) }] };
  }
);

// ── GET RESERVATION DETAIL ────────────────────────────────────────────────────
server.tool("get_reservation_detail",
  "Get full details for a specific reservation by ID",
  { reservationId: z.number() },
  async ({ reservationId }) => {
    const data = await hostawayFetch(`/reservations/${reservationId}`);
    return { content: [{ type: "text", text: JSON.stringify(data.result, null, 2) }] };
  }
);

// ── GET CONVERSATIONS ─────────────────────────────────────────────────────────
server.tool("get_conversations",
  "Get ALL guest conversations for a date range. Fetches every page automatically.",
  {
    listingId:     z.number().optional().describe("Filter by listing ID"),
    reservationId: z.number().optional().describe("Filter by reservation ID"),
    dateFrom:      z.string().optional().describe("Updated from this date YYYY-MM-DD"),
    dateTo:        z.string().optional().describe("Updated up to this date YYYY-MM-DD"),
  },
  async ({ listingId, reservationId, dateFrom, dateTo }) => {
    const params = {};
    if (listingId)     params.listingId     = listingId;
    if (reservationId) params.reservationId = reservationId;

    const inRange = (dateFrom || dateTo) ? dateFilter(dateFrom, dateTo) : null;

    const { total, records } = await fetchAll("/conversations", params, (c) => {
      if (inRange && !inRange(c.updatedOn || c.insertedOn)) return false;
      return true;
    });

    const conversations = records.map(c => ({
      id:            c.id,
      listingId:     c.listingId,
      listingName:   c.listingName,
      reservationId: c.reservationId,
      guestName:     c.guestName,
      channel:       c.channelName,
      lastMessage:   c.lastMessage,
      updatedAt:     c.updatedOn,
      createdAt:     c.insertedOn,
    }));

    return { content: [{ type: "text", text: JSON.stringify({ totalInHostaway: total, returned: conversations.length, conversations }, null, 2) }] };
  }
);

// ── SEND MESSAGE ──────────────────────────────────────────────────────────────
server.tool("send_message",
  "Send a message to a guest in a conversation",
  { conversationId: z.number(), message: z.string() },
  async ({ conversationId, message }) => {
    const data = await hostawayFetch(`/conversations/${conversationId}/messages`, {
      method: "POST", body: JSON.stringify({ body: message }),
    });
    return { content: [{ type: "text", text: `Message sent! ID: ${data.result?.id}` }] };
  }
);

// ── GET CALENDAR ──────────────────────────────────────────────────────────────
server.tool("get_calendar",
  "Get availability calendar for a listing. To check which properties are free on specific dates, use get_available_listings instead.",
  {
    listingId: z.number().describe("Listing ID"),
    dateFrom:  z.string().describe("Start date YYYY-MM-DD"),
    dateTo:    z.string().describe("End date YYYY-MM-DD"),
  },
  async ({ listingId, dateFrom, dateTo }) => {
    const data = await hostawayFetch(`/listings/${listingId}/calendar?startDate=${dateFrom}&endDate=${dateTo}`);
    return { content: [{ type: "text", text: JSON.stringify(data.result, null, 2) }] };
  }
);

// ── GET AVAILABLE LISTINGS ────────────────────────────────────────────────────
server.tool("get_available_listings",
  "Find which properties are available (not booked) for specific dates. Checks ALL reservations automatically.",
  {
    dateFrom: z.string().describe("Start date to check YYYY-MM-DD"),
    dateTo:   z.string().describe("End date to check YYYY-MM-DD"),
  },
  async ({ dateFrom, dateTo }) => {
    const checkFrom = new Date(dateFrom);
    const checkTo   = new Date(dateTo);

    // Fetch all listings and all reservations in parallel
    const [listingsResult, reservationsResult] = await Promise.all([
      fetchAll("/listings", {}),
      fetchAll("/reservations", { startDate: dateFrom, endDate: dateTo }),
    ]);

    const allListings     = listingsResult.records;
    const allReservations = reservationsResult.records;

    // Find booked listing IDs in the date range
    const bookedIds = new Set();
    allReservations.forEach(r => {
      if (["cancelled", "inquiry"].includes(r.status)) return;
      const resIn  = new Date(r.arrivalDate);
      const resOut = new Date(r.departureDate);
      // Overlaps if: resIn < checkTo AND resOut > checkFrom
      if (resIn < checkTo && resOut > checkFrom) {
        bookedIds.add(r.listingMapId);
      }
    });

    const available = allListings
      .filter(l => l.status === "active" && !bookedIds.has(l.id))
      .map(l => ({ id: l.id, name: l.name, bedrooms: l.bedroomsNumber, capacity: l.personCapacity }));

    const booked = allListings
      .filter(l => bookedIds.has(l.id))
      .map(l => ({ id: l.id, name: l.name }));

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          period: { from: dateFrom, to: dateTo },
          availableCount: available.length,
          bookedCount:    booked.length,
          available,
          booked,
        }, null, 2),
      }],
    };
  }
);

// ── GET FINANCIALS ────────────────────────────────────────────────────────────
server.tool("get_financials",
  "Get complete revenue summary for a date range. Fetches ALL reservations automatically, no data missed.",
  {
    dateFrom:  z.string().describe("Start date YYYY-MM-DD"),
    dateTo:    z.string().describe("End date YYYY-MM-DD"),
    dateType:  z.enum(["checkIn","booked"]).optional().describe("Filter by check-in date or booking date, default checkIn"),
    listingId: z.number().optional().describe("Filter by listing ID"),
  },
  async ({ dateFrom, dateTo, dateType = "checkIn", listingId }) => {
    const params = {};
    if (dateType === "checkIn") { params.startDate = dateFrom; params.endDate = dateTo; }
    else { params.createdAfter = dateFrom; params.createdBefore = dateTo; }
    if (listingId) params.listingId = listingId;

    const { total, records } = await fetchAll("/reservations", params,
      r => r.status !== "cancelled"
    );

    const summary = {
      period: { from: dateFrom, to: dateTo, type: dateType },
      totalReservationsScanned: total,
      totalActiveReservations: records.length,
      totalRevenue: records.reduce((s, r) => s + (parseFloat(r.totalPrice) || 0), 0).toFixed(2),
      currency: records[0]?.currency || "USD",
      byChannel: {},
      byListing: {},
    };

    records.forEach(r => {
      const ch = r.channelName || "Direct";
      if (!summary.byChannel[ch]) summary.byChannel[ch] = { count: 0, revenue: 0 };
      summary.byChannel[ch].count++;
      summary.byChannel[ch].revenue = +(summary.byChannel[ch].revenue + (parseFloat(r.totalPrice) || 0)).toFixed(2);

      const ln = r.listingName || `Listing ${r.listingMapId}`;
      if (!summary.byListing[ln]) summary.byListing[ln] = { count: 0, revenue: 0 };
      summary.byListing[ln].count++;
      summary.byListing[ln].revenue = +(summary.byListing[ln].revenue + (parseFloat(r.totalPrice) || 0)).toFixed(2);
    });

    return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
  }
);

// ── GET REVIEWS ───────────────────────────────────────────────────────────────
server.tool("get_reviews",
  "Get guest reviews. Automatically paginates all pages to find matches.",
  {
    listingId:  z.number().optional().describe("Filter by listing ID"),
    rating:     z.number().optional().describe("Filter by star rating 1-5"),
    dateFrom:   z.string().optional().describe("Reviews from YYYY-MM-DD"),
    dateTo:     z.string().optional().describe("Reviews up to YYYY-MM-DD"),
    maxResults: z.number().optional().describe("Max results default 50"),
  },
  async ({ listingId, rating, dateFrom, dateTo, maxResults = 50 }) => {
    const params = {};
    if (listingId) params.listingId = listingId;

    const inRange = (dateFrom || dateTo) ? dateFilter(dateFrom, dateTo) : null;

    const { total, records } = await fetchAll("/reviews", params, (r) => {
      if (!r.rating && !r.submittedAt) return false; // skip host-written
      if (inRange && !inRange(r.submittedAt)) return false;
      if (rating && r.rating !== rating) return false;
      return true;
    });

    const reviews = records.slice(0, maxResults).map(r => ({
      id:            r.id,
      listingName:   r.listingName,
      guestName:     r.reviewerName,
      rating:        r.rating,
      publicReview:  r.publicReview,
      submittedAt:   r.submittedAt,
      channel:       r.channelName,
    }));

    const avg = reviews.filter(r => r.rating).length
      ? (reviews.reduce((s, r) => s + (r.rating || 0), 0) / reviews.filter(r => r.rating).length).toFixed(2)
      : "N/A";

    return { content: [{ type: "text", text: JSON.stringify({ totalInHostaway: total, returned: reviews.length, averageRating: avg, reviews }, null, 2) }] };
  }
);

// ─── EXPRESS ──────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// OAuth (required by Claude)
app.get("/.well-known/oauth-authorization-server", (req, res) => {
  res.json({
    issuer: SERVER_URL,
    authorization_endpoint: `${SERVER_URL}/oauth/authorize`,
    token_endpoint: `${SERVER_URL}/oauth/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
  });
});
app.get("/oauth/authorize", (req, res) => {
  const { redirect_uri, state } = req.query;
  const url = new URL(redirect_uri);
  url.searchParams.set("code", "hostaway-code-" + Date.now());
  if (state) url.searchParams.set("state", state);
  res.redirect(url.toString());
});
app.post("/oauth/token", (req, res) => {
  res.json({ access_token: "hostaway-token-" + Date.now(), token_type: "bearer", expires_in: 86400 });
});

// MCP
app.post("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get("/health", (_, res) => res.json({ status: "ok", tools: 9 }));
app.listen(PORT, () => console.log(`Hostaway MCP running on port ${PORT}`));
