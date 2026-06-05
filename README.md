# 🏠 Hostaway MCP Server for Claude

Connect Claude directly to your Hostaway account — view listings, manage reservations, read guest messages, check availability, and get financial reports.

---

## What Claude Can Do With This

| Tool | What it does |
|------|-------------|
| `list_listings` | Show all your properties |
| `get_reservations` | List bookings (filter by status, date, listing) |
| `get_reservation_detail` | Full detail on one booking |
| `get_conversations` | Read guest messages |
| `send_message` | Send a message to a guest |
| `get_calendar` | Check availability for a property |
| `get_financials` | Revenue summary by date range & channel |

---

## Step 1 — Get Your Hostaway API Credentials

1. Log in to your **Hostaway Dashboard**
2. Go to **Settings → Hostaway API**
3. Click **Create** → give it a name (e.g. "Claude MCP")
4. Copy your **Account ID** and **API Key** (shown only once — save it!)

---

## Step 2 — Run the Server Locally (Test First)

```bash
# Clone / copy this folder, then:
cd hostaway-mcp
npm install

# Set your credentials
cp .env.example .env
# Edit .env and fill in your values

# Start the server
node -r dotenv/config server.js
# → Server running at http://localhost:3000/mcp
```

Test it's working:
```bash
curl http://localhost:3000/health
# → {"status":"ok","server":"hostaway-mcp"}
```

---

## Step 3 — Deploy to the Internet (Pick One)

You need a public HTTPS URL so Claude can reach your server.

### Option A: Railway (Easiest — Free Tier Available)

1. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
2. Push this folder to a GitHub repo first
3. In Railway, set these **Environment Variables**:
   ```
   HOSTAWAY_ACCOUNT_ID=your_account_id
   HOSTAWAY_API_KEY=your_api_key
   MCP_API_KEY=your_random_secret
   PORT=3000
   ```
4. Railway gives you a URL like: `https://hostaway-mcp-production.up.railway.app`
5. Your MCP URL = `https://hostaway-mcp-production.up.railway.app/mcp`

### Option B: Render (Also Free Tier)

1. Go to [render.com](https://render.com) → New Web Service
2. Connect your GitHub repo
3. Build command: `npm install`
4. Start command: `node server.js`
5. Add the same environment variables above

### Option C: Cloudflare Workers / VPS
Any server that can run Node.js 18+ and expose HTTPS works fine.

---

## Step 4 — Add to Claude as a Custom Connector

1. Open Claude → click your **profile icon** → **Settings**
2. Go to **Connectors** → **Add Custom Connector**
3. Enter your MCP URL:  
   `https://your-deployment-url.com/mcp`
4. If you set `MCP_API_KEY`, add a custom header:  
   **Header name:** `x-api-key`  
   **Header value:** `your_mcp_api_key_value`
5. Click **Save**

That's it! Claude will now have Hostaway tools available.

---

## Usage Examples (ask Claude these things)

- *"Show me all my listings"*
- *"What reservations are checking in this week?"*
- *"Get the conversation for reservation 12345"*
- *"Send a welcome message to reservation 67890"*
- *"What's my revenue for June 2025 broken down by channel?"*
- *"Is the beach villa available from July 10-20?"*

---

## Security Notes

- Always set `MCP_API_KEY` in production — it protects your endpoint
- Your Hostaway API key is stored only in your server's environment variables
- The server never logs credentials
- Access tokens are cached and refreshed automatically

---

## Local Development with dotenv

```bash
npm install dotenv
node -r dotenv/config server.js
```

Or add to package.json scripts:
```json
"start:dev": "node -r dotenv/config server.js"
```
