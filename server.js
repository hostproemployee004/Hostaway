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

// Helper: client-side date filter on any array of objects
function filterByDate(arr, dateField, dateFrom, dateTo) {
  if (!dateFrom && !dateTo) return arr;
  const from = dateFrom ? new Date(dateFrom) : null;
  const to   = dateTo   ? new Date(dateTo + "T23:59:59Z") : null;
  return arr.filter(item => {
    const val = item[dateField];
    if (!val) return false;
    const d = new Date(val);
    if (from && d < from) return false;
    if (to   && d > to)   return false;
    return true;
  });
}

// ─── MCP SERVER ───────────────────────────────────────────────────────────────
const server = new McpServer({ name: "hostaway-mcp", version: "1.0.0" });

// ── LIST LISTINGS ─────────────────────────────────────────────────────────────
server.tool("list_listings",
  "Get all property listings. Filter by creation date or active status.",
  {
    dateFrom:  z.string().optional().describe("Listings created from this date (YYYY-MM-DD)"),
    dateTo:    z.string().optional().describe("Listings created up to this date (YYYY-MM-DD)"),
    status:    z.enum(["active","inactive"]).optional().describe("Filter by listing status"),
    limit:     z.number().optional().describe("Max results (default 50)"),
    offset:    z.number().optional().describe("Pagination offset"),
  },
  async ({ dateFrom, dateTo, status, limit = 50, offset = 0 }) => {
    const params = new URLSearchParams({ limit, offset });
    if (status) params.set("status", status);

    const data = await hostawayFetch(`/listings?${params}`);
    let listings = data.result.map((l) => ({
      id:          l.id,
      name:        l.name,
      address:     l.address,
      bedrooms:    l.bedroomsNumber,
      bathrooms:   l.bathroomsNumber,
      capacity:    l.personCapacity,
      status:      l.status,
      createdAt:   l.insertedOn,
      updatedAt:   l.updatedOn,
    }));

    // Client-side date filter on createdAt
    listings = filterByDate(listings, "createdAt", dateFrom, dateTo);

    return { content: [{ type: "text", text: JSON.stringify({ total: data.count, returned: listings.length, listings }, null, 2) }] };
  }
);

// ── GET RESERVATIONS ──────────────────────────────────────────────────────────
server.tool("get_reservations",
  "Get reservations filtered by check-in date range, booking date, status, channel, or listing.",
  {
    checkInFrom:   z.string().optional().describe("Check-in from date (YYYY-MM-DD)"),
    checkInTo:     z.string().optional().describe("Check-in to date (YYYY-MM-DD)"),
    checkOutFrom:  z.string().optional().describe("Check-out from date (YYYY-MM-DD)"),
    checkOutTo:    z.string().optional().describe("Check-out to date (YYYY-MM-DD)"),
    bookedFrom:    z.string().optional().describe("Booking created from date (YYYY-MM-DD)"),
    bookedTo:      z.string().optional().describe("Booking created to date (YYYY-MM-DD)"),
    status:        z.enum(["new","modified","cancelled","ownerStay","inquiry","tentative","blocked"]).optional(),
    channelName:   z.string().optional().describe("Filter by channel e.g. airbnb, booking.com"),
    listingId:     z.number().optional().describe("Filter by listing ID"),
    limit:         z.number().optional().describe("Max results (default 50)"),
  },
  async ({ checkInFrom, checkInTo, checkOutFrom, checkOutTo, bookedFrom, bookedTo, status, channelName, listingId, limit = 50 }) => {
    const params = new URLSearchParams({ limit });
    if (status)      params.set("status", status);
    if (listingId)   params.set("listingId", listingId);
    if (checkInFrom) params.set("startDate", checkInFrom);
    if (checkInTo)   params.set("endDate", checkInTo);
    if (bookedFrom)  params.set("createdAfter", bookedFrom);
    if (bookedTo)    params.set("createdBefore", bookedTo);

    const data = await hostawayFetch(`/reservations?${params}`);
    let reservations = data.result.map((r) => ({
      id:          r.id,
      listingId:   r.listingMapId,
      listingName: r.listingName,
      guestName:   `${r.guestFirstName} ${r.guestLastName}`,
      guestEmail:  r.guestEmail,
      checkIn:     r.arrivalDate,
      checkOut:    r.departureDate,
      bookedOn:    r.insertedOn,
      updatedOn:   r.updatedOn,
      nights:      r.nights,
      guests:      r.adults + (r.children || 0),
      status:      r.status,
      channel:     r.channelName,
      totalPrice:  r.totalPrice,
      currency:    r.currency,
    }));

    // Client-side filters
    if (checkOutFrom || checkOutTo) reservations = filterByDate(reservations, "checkOut", checkOutFrom, checkOutTo);
    if (channelName) reservations = reservations.filter(r => r.channel?.toLowerCase().includes(channelName.toLowerCase()));

    return { content: [{ type: "text", text: JSON.stringify({ total: data.count, returned: reservations.length, reservations }, null, 2) }] };
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
  "Get guest conversations/messages, filtered by date or listing.",
  {
    listingId:     z.number().optional().describe("Filter by listing ID"),
    reservationId: z.number().optional().describe("Filter by reservation ID"),
    dateFrom:      z.string().optional().describe("Conversations from this date (YYYY-MM-DD)"),
    dateTo:        z.string().optional().describe("Conversations up to this date (YYYY-MM-DD)"),
    limit:         z.number().optional().describe("Max results (default 50)"),
  },
  async ({ listingId, reservationId, dateFrom, dateTo, limit = 50 }) => {
    const params = new URLSearchParams({ limit });
    if (listingId)     params.set("listingId", listingId);
    if (reservationId) params.set("reservationId", reservationId);

    const data = await hostawayFetch(`/conversations?${params}`);
    let conversations = data.result.map(c => ({
      id:            c.id,
      listingId:     c.listingId,
      reservationId: c.reservationId,
      guestName:     c.guestName,
      channel:       c.channelName,
      lastMessage:   c.lastMessage,
      createdAt:     c.insertedOn,
      updatedAt:     c.updatedOn,
    }));

    // Client-side date filter on updatedAt
    conversations = filterByDate(conversations, "updatedAt", dateFrom, dateTo);

    return { content: [{ type: "text", text: JSON.stringify({ total: data.count, returned: conversations.length, conversations }, null, 2) }] };
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
    return { content: [{ type: "text", text: `✅ Message sent! ID: ${data.result?.id}` }] };
  }
);

// ── GET CALENDAR ──────────────────────────────────────────────────────────────
server.tool("get_calendar",
  "Get calendar availability for a listing between two dates",
  {
    listingId:  z.number().describe("Listing ID"),
    dateFrom:   z.string().describe("Start date (YYYY-MM-DD)"),
    dateTo:     z.string().describe("End date (YYYY-MM-DD)"),
  },
  async ({ listingId, dateFrom, dateTo }) => {
    const data = await hostawayFetch(`/listings/${listingId}/calendar?startDate=${dateFrom}&endDate=${dateTo}`);
    return { content: [{ type: "text", text: JSON.stringify(data.result, null, 2) }] };
  }
);

// ── GET FINANCIALS ────────────────────────────────────────────────────────────
server.tool("get_financials",
  "Get revenue and booking summary for a date range, broken down by channel and listing",
  {
    dateFrom:  z.string().describe("Start date (YYYY-MM-DD)"),
    dateTo:    z.string().describe("End date (YYYY-MM-DD)"),
    dateType:  z.enum(["checkIn","booked"]).optional().describe("Whether dates refer to check-in date or booking date (default: checkIn)"),
    listingId: z.number().optional().describe("Filter by listing ID"),
  },
  async ({ dateFrom, dateTo, dateType = "checkIn", listingId }) => {
    const params = new URLSearchParams({ limit: 100 });
    if (dateType === "checkIn") {
      params.set("startDate", dateFrom);
      params.set("endDate", dateTo);
    } else {
      params.set("createdAfter", dateFrom);
      params.set("createdBefore", dateTo);
    }
    if (listingId) params.set("listingId", listingId);

    const data = await hostawayFetch(`/reservations?${params}`);
    const reservations = data.result.filter(r => r.status !== "cancelled");

    const summary = {
      period:            { from: dateFrom, to: dateTo, type: dateType },
      totalReservations: reservations.length,
      totalRevenue:      reservations.reduce((s, r) => s + (parseFloat(r.totalPrice) || 0), 0).toFixed(2),
      currency:          reservations[0]?.currency || "USD",
      byChannel:         {},
      byListing:         {},
    };

    reservations.forEach(r => {
      // By channel
      const ch = r.channelName || "Direct";
      if (!summary.byChannel[ch]) summary.byChannel[ch] = { count: 0, revenue: 0 };
      summary.byChannel[ch].count++;
      summary.byChannel[ch].revenue = (parseFloat(summary.byChannel[ch].revenue) + (parseFloat(r.totalPrice) || 0)).toFixed(2);

      // By listing
      const ln = r.listingName || r.listingMapId;
      if (!summary.byListing[ln]) summary.byListing[ln] = { count: 0, revenue: 0 };
      summary.byListing[ln].count++;
      summary.byListing[ln].revenue = (parseFloat(summary.byListing[ln].revenue) + (parseFloat(r.totalPrice) || 0)).toFixed(2);
    });

    return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
  }
);

// ── GET REVIEWS ───────────────────────────────────────────────────────────────
server.tool("get_reviews",
  "Get guest reviews filtered by date, rating, listing. Paginates automatically to find matches.",
  {
    listingId:  z.number().optional().describe("Filter by listing ID"),
    rating:     z.number().optional().describe("Filter by star rating 1-5"),
    dateFrom:   z.string().optional().describe("Reviews submitted from YYYY-MM-DD"),
    dateTo:     z.string().optional().describe("Reviews submitted up to YYYY-MM-DD"),
    guestOnly:  z.boolean().optional().describe("Only guest reviews with ratings, default true"),
    maxResults: z.number().optional().describe("Max results to return, default 50"),
  },
  async ({ listingId, rating, dateFrom, dateTo, guestOnly = true, maxResults = 50 }) => {
    const from = dateFrom ? new Date(dateFrom) : null;
    const to   = dateTo   ? new Date(dateTo + "T23:59:59Z") : null;

    let matched = [];
    let offset  = 0;
    const batchSize = 100;
    let totalInDB = 0;
    let pagesScanned = 0;
    let consecutiveEmpty = 0;

    while (matched.length < maxResults && consecutiveEmpty < 5) {
      const params = new URLSearchParams({ limit: batchSize, offset });
      if (listingId) params.set("listingId", listingId);

      const data = await hostawayFetch("/reviews?" + params.toString());
      totalInDB = data.count;
      pagesScanned++;

      const batch = data.result || [];
      if (!batch.length) break;

      const filtered = batch.filter(r => {
        if (guestOnly && !r.rating && !r.submittedAt) return false;
        if (from || to) {
          if (!r.submittedAt) return false;
          const d = new Date(r.submittedAt);
          if (from && d < from) return false;
          if (to   && d > to)   return false;
        }
        if (rating && r.rating !== rating) return false;
        return true;
      });

      if (filtered.length === 0) consecutiveEmpty++;
      else consecutiveEmpty = 0;

      matched.push(...filtered);
      offset += batchSize;
      if (offset >= totalInDB) break;
    }

    matched = matched.slice(0, maxResults);

    const mapped = matched.map(r => ({
      id:            r.id,
      listingId:     r.listingId,
      listingName:   r.listingName,
      reservationId: r.reservationId,
      guestName:     r.reviewerName,
      rating:        r.rating,
      publicReview:  r.publicReview,
      submittedAt:   r.submittedAt,
      channel:       r.channelName,
    }));

    const rated = mapped.filter(r => r.rating);
    const avg = rated.length
      ? (rated.reduce((s, r) => s + r.rating, 0) / rated.length).toFixed(2)
      : "N/A";

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          totalInDB, pagesScanned, returned: mapped.length,
          averageRating: avg,
          filters: { dateFrom, dateTo, rating, guestOnly },
          reviews: mapped,
        }, null, 2),
      }],
    };
  }
);

// ── GET REVIEW SUMMARY ────────────────────────────────────────────────────────
server.tool("get_review_summary",
  "Get an overall rating summary broken down by channel and listing, with optional date range",
  {
    listingId: z.number().optional().describe("Filter by listing ID"),
    dateFrom:  z.string().optional().describe("Reviews submitted from (YYYY-MM-DD)"),
    dateTo:    z.string().optional().describe("Reviews submitted up to (YYYY-MM-DD)"),
  },
  async ({ listingId, dateFrom, dateTo }) => {
    const params = new URLSearchParams({ limit: 100 });
    if (listingId) params.set("listingId", listingId);
    if (dateFrom)  params.set("submittedAtStart", dateFrom);
    if (dateTo)    params.set("submittedAtEnd", dateTo);

    const data = await hostawayFetch(`/reviews?${params}`);
    let reviews = filterByDate(data.result, "submittedAt", dateFrom, dateTo);

    if (!reviews.length) return { content: [{ type: "text", text: "No reviews found for this period." }] };

    const rated = reviews.filter(r => r.rating);
    const summary = {
      period:          { from: dateFrom || "all time", to: dateTo || "now" },
      totalReviews:    reviews.length,
      averageRating:   rated.length ? (rated.reduce((s, r) => s + r.rating, 0) / rated.length).toFixed(2) : "N/A",
      ratingBreakdown: { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 },
      byChannel:       {},
      byListing:       {},
      recentReviews:   reviews.slice(0, 5).map(r => ({
        guest: r.reviewerName, rating: r.rating,
        review: r.publicReview, date: r.submittedAt, listing: r.listingName,
      })),
    };

    reviews.forEach(r => {
      if (r.rating) summary.ratingBreakdown[r.rating] = (summary.ratingBreakdown[r.rating] || 0) + 1;

      const ch = r.channelName || "Direct";
      if (!summary.byChannel[ch]) summary.byChannel[ch] = { count: 0, totalRating: 0 };
      summary.byChannel[ch].count++;
      summary.byChannel[ch].totalRating += r.rating || 0;

      const ln = r.listingName || r.listingId;
      if (!summary.byListing[ln]) summary.byListing[ln] = { count: 0, totalRating: 0 };
      summary.byListing[ln].count++;
      summary.byListing[ln].totalRating += r.rating || 0;
    });

    // Compute averages
    [summary.byChannel, summary.byListing].forEach(group => {
      Object.keys(group).forEach(k => {
        group[k].averageRating = group[k].count ? (group[k].totalRating / group[k].count).toFixed(2) : "N/A";
        delete group[k].totalRating;
      });
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

// ─── OAUTH (required by Claude) ───────────────────────────────────────────────
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
  const code = "hostaway-auth-code-" + Date.now();
  const url = new URL(redirect_uri);
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  res.redirect(url.toString());
});

app.post("/oauth/token", (req, res) => {
  res.json({ access_token: "hostaway-mcp-token-" + Date.now(), token_type: "bearer", expires_in: 86400 });
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
