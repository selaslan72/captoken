# CapToken 🛡️

**CapToken** is a lightweight, high-performance, and secure API Gateway and Budget Guard for Large Language Models (LLMs). It acts as an OpenAI-compatible reverse proxy that helps developers and businesses prevent runaway API costs and block autonomous AI agents from getting stuck in infinite token-consuming loops.

Built with **Node.js, Fastify, TypeScript, and SQLite**, CapToken features zero-latency stream chunk forwarding and a premium glassmorphic dashboard to monitor real-time consumption.

---

## ✨ Features

- **💰 Cost & Budget Capping:** Define daily and monthly spend limits ($) per proxy key. Requests are blocked instantly (HTTP 402) at the gateway if limits are exceeded, saving you from surprise API bills.
- **🔄 Autonomous Agent Loop Guard:** Protect your budget from infinite agent loops. Automatically flags and blocks (HTTP 429) proxy keys that make excessive requests within a short timeframe.
- **⚡ Zero-Latency Streaming:** Fully supports SSE (Server-Sent Events) chat completion streaming. Chunks are piped to the client with zero overhead while token usage is audited and logged asynchronously on stream completion.
- **📊 Premium Glassmorphic Dashboard:** Monitor total API spend, request volume, active keys, and live transaction logs with interactive charts (Chart.js).
- **🔌 Drop-in Replacement:** OpenAI API compatibility. Just change the `baseURL` in your OpenAI/Gemini SDK configuration.

---

## 🛠️ Tech Stack

- **Runtime:** Node.js (v18+)
- **Server:** Fastify (for ultra-low overhead and efficient I/O streaming)
- **Database:** SQLite (embedded, fast, easily migratable to PostgreSQL/Supabase)
- **Token Counter:** `js-tiktoken` (pure JavaScript, zero native C++ compile dependencies)
- **Frontend:** Vanilla HTML5 / CSS3 (sleek dark mode, responsive layout, Chart.js, Lucide Icons)

---

## 🚀 Getting Started

### 1. Installation

Clone this repository and install dependencies:

```bash
git clone https://github.com/YOUR_USERNAME/captoken.git
cd captoken
npm install
```

### 2. Configuration

Create a `.env` file in the root directory:

```env
PORT=3000
HOST=0.0.0.0
```

### 3. Build & Run

Build the TypeScript files and start the production server:

```bash
# Build TypeScript
npm run build

# Start server
npm start
```

For development mode (auto-compiles and starts):

```bash
npm run dev
```

The gateway and dashboard will be available at `http://localhost:3000`.

---

## 🔌 API Usage Example

To route requests through CapToken, simply set the `baseURL` to your CapToken server address and replace the OpenAI API key with your generated `captoken_...` proxy key.

### Node.js Example

```javascript
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: "captoken_your_generated_key_here", // Generated from the CapToken Dashboard
  baseURL: "http://localhost:3000/v1"        // Your CapToken server gateway
});

async function main() {
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "Hello, CapToken!" }],
    stream: true, // Seamless stream support
  });

  for await (const chunk of completion) {
    process.stdout.write(chunk.choices[0]?.delta?.content || "");
  }
}

main();
```

---

## 🗄️ Database Architecture

CapToken stores configuration and transactions inside a local SQLite database (`captoken.db`):
- `api_keys`: Stores proxy keys, active states, and target provider credentials (encrypted or plaintext).
- `usage_summary`: Records aggregated token and cost data grouped by date for fast limit checking.
- `request_logs`: Stores granular transaction records for analytics and loop detection audits.

---

## 📄 License

This project is licensed under the MIT License.
