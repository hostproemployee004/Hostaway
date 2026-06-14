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

// ─── SMART FETCH: paginate with a max page cap to avoid timeouts ──────────────
async function smartFetch(endpoint, extraParams = {}, options = {}) {
  const {
    maxPages   = 10,   // max pages to fetch (10 x 100 = 1000 records max)
    filterFn   = null,
  } = options;

  const BATCH  = 100;
  let offset   = 0;
  let total    = null;
  let all      = [];
  let pages    = 0;

  while (pages < maxPages) {
    const params = new URLSearchParams({ limit: BATCH, offset, ...extraParams });
    const data   = await hostawayFetch(`${endpoint}?${params}`);
    total        = data.count;

    const batch = data.result || [];
    if (!batch.length) break;

    const keep = filterFn ? batch.filter(filterFn) : batch;
    all.push(...keep);

    offset += BATCH;
    pages++;
    if (offset >= total) break;
  }

  return { total, pages, records: all };
}

// ─── MCP SERVER ───────────────────────────────────────────────────────────────
const server = new McpServer({ name: "hostaway-mcp", version: "1.0.0" });

// ── LIST LISTINGS ─────────────────────────────────────────────────────────────
server.tool("list_listings",
  "Get all property listings.",
  { status: z.enum(["active","inactive"]).optional() },
  async ({ status }) => {
    const params = { limit: 100 };
    if (status) params.status = status;
    const { total, records } = await smartFetch("/listings", params, { maxPages: 5 });
    const listings = records.map(l => ({
      id: l.id, name: l.name, address: l.address,
      bedrooms: l.bedroomsNumber, capacity: l.personCapacity, status: l.status,
    }));
    return { content: [{ type: "text", text: JSON.stringify({ totalInHostaway: total, returned: listings.length, listings }, null, 2) }] };
  }
);

// ── GET RESERVATIONS ──────────────────────────────────────────────────────────
server.tool("get_reservations",
  "Get reservations for a specific date range. Always pass checkInFrom and checkInTo to narrow results and avoid timeouts.",
  {
    checkInFrom:  z.string().optional().describe("Check-in from YYYY-MM-DD. For 'today' use today's date."),
    checkInTo:    z.string().optional().describe("Check-in to YYYY-MM-DD. For 'today' use today's date."),
    checkOutFrom: z.string().optional().describe("Check-out from YYYY-MM-DD"),
    checkOutTo:   z.string().optional().describe("Check-out to YYYY-MM-DD"),
    bookedFrom:   z.string().optional().describe("Booking created from YYYY-MM-DD"),
    bookedTo:     z.string().optional().describe("Booking created to YYYY-MM-DD"),
    status:       z.enum(["new","modified","cancelled","ownerStay","inquiry","tentative","blocked"]).optional(),
    channelName:  z.string().optional().describe("Filter by channel e.g. airbnb"),
    listingId:    z.number().optional().describe("Filter by listing ID"),
  },
  async ({ checkInFrom, checkInTo, checkOutFrom, checkOutTo, bookedFrom, bookedTo, status, channelName, listingId }) => {
    const params = {};
    if (status)      params.status        = status;
    if (listingId)   params.listingId     = listingId;
    if (checkInFrom) params.startDate     = checkInFrom;
    if (checkInTo)   params.endDate       = checkInTo;
    if (bookedFrom)  params.createdAfter  = bookedFrom;
    if (bookedTo)    params.createdBefore = bookedTo;

    const { total, records } = await smartFetch("/reservations", params, {
      maxPages: 20,
      filterFn: (r) => {
        if (channelName && !r.channelName?.toLowerCase().includes(channelName.toLowerCase())) return false;
        if (checkOutFrom && new Date(r.departureDate) < new Date(checkOutFrom)) return false;
        if (checkOutTo   && new Date(r.departureDate) > new Date(checkOutTo + "T23:59:59Z")) return false;
        return true;
      },
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
  "Get guest conversations. Always pass dateFrom/dateTo to avoid timeouts.",
  {
    listingId:     z.number().optional(),
    reservationId: z.number().optional(),
    dateFrom:      z.string().optional().describe("Updated from YYYY-MM-DD"),
    dateTo:        z.string().optional().describe("Updated to YYYY-MM-DD"),
  },
  async ({ listingId, reservationId, dateFrom, dateTo }) => {
    const params = {};
    if (listingId)     params.listingId     = listingId;
    if (reservationId) params.reservationId = reservationId;

    const from = dateFrom ? new Date(dateFrom) : null;
    const to   = dateTo   ? new Date(dateTo + "T23:59:59Z") : null;

    const { total, records } = await smartFetch("/conversations", params, {
      maxPages: 20,
      filterFn: (c) => {
        if (!from && !to) return true;
        const d = new Date(c.updatedOn || c.insertedOn);
        if (from && d < from) return false;
        if (to   && d > to)   return false;
        return true;
      },
    });

    const conversations = records.map(c => ({
      id:            c.id,
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

// ── GET AVAILABLE LISTINGS ────────────────────────────────────────────────────
server.tool("get_available_listings",
  "Find which properties are available (not booked) on specific dates.",
  {
    dateFrom: z.string().describe("Start date YYYY-MM-DD"),
    dateTo:   z.string().describe("End date YYYY-MM-DD"),
  },
  async ({ dateFrom, dateTo }) => {
    const checkFrom = new Date(dateFrom);
    const checkTo   = new Date(dateTo);

    const [listingsRes, reservationsRes] = await Promise.all([
      smartFetch("/listings", {}, { maxPages: 5 }),
      smartFetch("/reservations", { startDate: dateFrom, endDate: dateTo }, { maxPages: 20 }),
    ]);

    const bookedIds = new Set();
    reservationsRes.records.forEach(r => {
      if (["cancelled", "inquiry"].includes(r.status)) return;
      const resIn  = new Date(r.arrivalDate);
      const resOut = new Date(r.departureDate);
      if (resIn < checkTo && resOut > checkFrom) bookedIds.add(r.listingMapId);
    });

    const available = listingsRes.records
      .filter(l => l.status === "active" && !bookedIds.has(l.id))
      .map(l => ({ id: l.id, name: l.name, bedrooms: l.bedroomsNumber, capacity: l.personCapacity }));

    const booked = listingsRes.records
      .filter(l => bookedIds.has(l.id))
      .map(l => ({ id: l.id, name: l.name }));

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ period: { from: dateFrom, to: dateTo }, availableCount: available.length, bookedCount: booked.length, available, booked }, null, 2),
      }],
    };
  }
);

// ── GET CALENDAR ──────────────────────────────────────────────────────────────
server.tool("get_calendar",
  "Get availability calendar for a specific listing.",
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

// ── GET FINANCIALS ────────────────────────────────────────────────────────────
server.tool("get_financials",
  "Get revenue summary for a date range, broken down by channel and listing.",
  {
    dateFrom:  z.string().describe("Start date YYYY-MM-DD"),
    dateTo:    z.string().describe("End date YYYY-MM-DD"),
    dateType:  z.enum(["checkIn","booked"]).optional().describe("Filter by check-in or booking date, default checkIn"),
    listingId: z.number().optional(),
  },
  async ({ dateFrom, dateTo, dateType = "checkIn", listingId }) => {
    const params = {};
    if (dateType === "checkIn") { params.startDate = dateFrom; params.endDate = dateTo; }
    else { params.createdAfter = dateFrom; params.createdBefore = dateTo; }
    if (listingId) params.listingId = listingId;

    const { total, records } = await smartFetch("/reservations", params, {
      maxPages: 20,
      filterFn: r => r.status !== "cancelled",
    });

    const summary = {
      period: { from: dateFrom, to: dateTo, type: dateType },
      totalScanned: total,
      totalActive: records.length,
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
  "Get guest reviews with optional filters.",
  {
    listingId:  z.number().optional(),
    rating:     z.number().optional().describe("Star rating 1-5"),
    dateFrom:   z.string().optional().describe("Submitted from YYYY-MM-DD"),
    dateTo:     z.string().optional().describe("Submitted to YYYY-MM-DD"),
    maxResults: z.number().optional().describe("Max results default 50"),
  },
  async ({ listingId, rating, dateFrom, dateTo, maxResults = 50 }) => {
    const params = {};
    if (listingId) params.listingId = listingId;

    const from = dateFrom ? new Date(dateFrom) : null;
    const to   = dateTo   ? new Date(dateTo + "T23:59:59Z") : null;

    const { total, records } = await smartFetch("/reviews", params, {
      maxPages: 20,
      filterFn: (r) => {
        if (!r.rating && !r.submittedAt) return false;
        if (rating && r.rating !== rating) return false;
        if (from || to) {
          if (!r.submittedAt) return false;
          const d = new Date(r.submittedAt);
          if (from && d < from) return false;
          if (to   && d > to)   return false;
        }
        return true;
      },
    });

    const reviews = records.slice(0, maxResults).map(r => ({
      id: r.id, listingName: r.listingName, guestName: r.reviewerName,
      rating: r.rating, publicReview: r.publicReview,
      submittedAt: r.submittedAt, channel: r.channelName,
    }));

    const rated = reviews.filter(r => r.rating);
    const avg = rated.length ? (rated.reduce((s, r) => s + r.rating, 0) / rated.length).toFixed(2) : "N/A";

    return { content: [{ type: "text", text: JSON.stringify({ totalInHostaway: total, returned: reviews.length, averageRating: avg, reviews }, null, 2) }] };
  }
);

// ── GET RESPONSE TIMES ────────────────────────────────────────────────────────
server.tool("get_response_times",
  "Analyze how quickly hosts replied to guests. Shows average response time in minutes, breakdown by day, and lists slow responses.",
  {
    dateFrom:         z.string().describe("From date YYYY-MM-DD"),
    dateTo:           z.string().describe("To date YYYY-MM-DD"),
    listingId:        z.number().optional().describe("Filter by listing ID"),
    slowThresholdMin: z.number().optional().describe("Minutes to flag as slow, default 15"),
    maxConvos:        z.number().optional().describe("Max conversations to analyze, default 40"),
  },
  async ({ dateFrom, dateTo, listingId, slowThresholdMin = 15, maxConvos = 40 }) => {
    const params = {};
    if (listingId) params.listingId = listingId;

    const from = new Date(dateFrom);
    const to   = new Date(dateTo + "T23:59:59Z");

    const { records: convos } = await smartFetch("/conversations", params, {
      maxPages: 10,
      filterFn: (c) => {
        const d = new Date(c.updatedOn || c.insertedOn);
        return d >= from && d <= to;
      },
    });

    if (!convos.length) {
      return { content: [{ type: "text", text: JSON.stringify({
        message: "No conversations found for this period.",
        dateFrom, dateTo,
        tip: "Try a broader date range e.g. last 7 days"
      }) }] };
    }

    const sample  = convos.slice(0, maxConvos);
    const results = [];
    const skipped = [];

    // Fetch in parallel batches of 5
    for (let i = 0; i < sample.length; i += 5) {
      const batch = sample.slice(i, i + 5);
      const batchOut = await Promise.all(batch.map(async (convo) => {
        try {
          const msgData = await hostawayFetch("/conversations/" + convo.id + "/messages");
          const raw = msgData.result || [];
          const messages = raw.sort((a, b) => new Date(a.insertedOn) - new Date(b.insertedOn));

          // Try multiple field names Hostaway might use for sender role
          const getRole = (msg) => {
            if (msg.senderRole)  return msg.senderRole;
            if (msg.type)        return msg.type;
            if (msg.authorType)  return msg.authorType;
            if (msg.direction === "incoming") return "guest";
            if (msg.direction === "outgoing") return "host";
            if (msg.isOutgoing === false)     return "guest";
            if (msg.isOutgoing === true)      return "host";
            return null;
          };

          let firstGuest = null;
          let firstHost  = null;

          for (const msg of messages) {
            const role = getRole(msg);
            if (!firstGuest && role === "guest") { firstGuest = msg; }
            else if (firstGuest && !firstHost && role === "host") { firstHost = msg; break; }
          }

          if (firstGuest && firstHost) {
            const diffMin = Math.round((new Date(firstHost.insertedOn) - new Date(firstGuest.insertedOn)) / 60000);
            return {
              conversationId:   convo.id,
              guestName:        convo.guestName,
              listingName:      convo.listingName,
              channel:          convo.channelName,
              guestMessageAt:   firstGuest.insertedOn,
              hostReplyAt:      firstHost.insertedOn,
              responseTimeMin:  diffMin,
              responseTimeHuman: diffMin < 60 ? diffMin + " min" : Math.floor(diffMin/60) + "h " + (diffMin%60) + "m",
              slow:             diffMin > slowThresholdMin,
            };
          }

          // Debug: return raw sample so we can see the real field names
          return {
            _skipped: true,
            conversationId: convo.id,
            guestName: convo.guestName,
            messageCount: messages.length,
            sampleMessageFields: raw[0] ? Object.keys(raw[0]) : [],
            sampleMessage: raw[0] || null,
          };

        } catch (e) {
          return { _error: true, conversationId: convo.id, error: e.message };
        }
      }));

      batchOut.forEach(r => {
        if (r && !r._skipped && !r._error) results.push(r);
        else if (r) skipped.push(r);
      });
    }

    const times  = results.map(r => r.responseTimeMin).filter(t => t >= 0);
    const avgMin = times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null;

    const byDay = {};
    results.forEach(r => {
      const day = r.guestMessageAt ? r.guestMessageAt.slice(0, 10) : "unknown";
      if (!byDay[day]) byDay[day] = { conversations: 0, totalMin: 0, slowCount: 0, slowGuests: [] };
      byDay[day].conversations++;
      byDay[day].totalMin += r.responseTimeMin;
      if (r.slow) { byDay[day].slowCount++; byDay[day].slowGuests.push(r.guestName); }
    });
    Object.keys(byDay).forEach(d => {
      byDay[d].avgResponseMin = Math.round(byDay[d].totalMin / byDay[d].conversations);
      byDay[d].avgResponseHuman = byDay[d].avgResponseMin < 60
        ? byDay[d].avgResponseMin + " min"
        : Math.floor(byDay[d].avgResponseMin/60) + "h " + (byDay[d].avgResponseMin%60) + "m";
      delete byDay[d].totalMin;
    });

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          period: { from: dateFrom, to: dateTo },
          conversationsFound:    convos.length,
          conversationsAnalyzed: sample.length,
          conversationsWithData: results.length,
          slowThresholdMin,
          averageResponseMin:   avgMin,
          averageResponseHuman: avgMin ? (avgMin < 60 ? avgMin + " min" : Math.floor(avgMin/60) + "h " + (avgMin%60) + "m") : "N/A",
          slowResponseCount:    results.filter(r => r.slow).length,
          slowResponses:        results.filter(r => r.slow).map(r => ({ guestName: r.guestName, listingName: r.listingName, responseTimeHuman: r.responseTimeHuman, guestMessageAt: r.guestMessageAt })),
          byDay,
          allResults: results,
          debugSkipped: skipped.slice(0, 3), // show first 3 skipped for diagnosis
        }, null, 2),
      }],
    };
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

app.post("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get("/health", (_, res) => res.json({ status: "ok", tools: 10 }));
app.listen(PORT, () => console.log(`Hostaway MCP running on port ${PORT}`));
