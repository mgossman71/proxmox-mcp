import dotenv from "dotenv";
// .env.local (untracked) holds secrets such as PROXMOX_TOKEN_SECRET and wins
// over the tracked .env.
dotenv.config({ path: [".env.local", ".env"], quiet: true });
import { randomUUID } from "crypto";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";
import { bearerAuth } from "./auth.js";
import { noMigrateTag } from "./tools/migration.js";
import { apiBaseUrl, tlsInsecure } from "./proxmox.js";

const PORT = parseInt(process.env.MCP_PORT || "3000", 10);
// Shared-secret auth for /mcp. When unset, requests are allowed (a warning is
// logged at startup) so local development stays frictionless.
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;

const app = express();
app.use(express.json());

// Map of session ID → transport for stateful sessions
const sessions = new Map<string, StreamableHTTPServerTransport>();

// Create a new MCP server instance for each session
async function handleSession(
  transport: StreamableHTTPServerTransport
): Promise<void> {
  const server = createServer();
  await server.connect(transport);
}

// Health check (left open so orchestrators can probe it without credentials)
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "proxmox-mcp" });
});

// MCP Streamable HTTP endpoint
app.all("/mcp", bearerAuth(MCP_AUTH_TOKEN), async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  try {
    // Existing session
    if (sessionId && sessions.has(sessionId)) {
      const transport = sessions.get(sessionId)!;
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // New session (initialize request or stateless)
    if (req.method === "POST") {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          sessions.delete(transport.sessionId);
        }
      };

      await handleSession(transport);
      await transport.handleRequest(req, res, req.body);

      // Session ID is set by the transport after processing the initialize request
      if (transport.sessionId) {
        sessions.set(transport.sessionId, transport);
      }
      return;
    }

    // GET without session — list available or 405
    if (req.method === "GET") {
      res.status(405).json({
        error: "Use POST to initialize a session, or provide mcp-session-id header",
      });
      return;
    }

    res.status(405).json({ error: `Method ${req.method} not allowed` });
  } catch (error: any) {
    console.error("MCP request error:", error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

app.listen(PORT, () => {
  console.log(`Proxmox MCP server listening on http://0.0.0.0:${PORT}`);
  console.log(`  MCP endpoint:   http://0.0.0.0:${PORT}/mcp`);
  console.log(`  Health check:   http://0.0.0.0:${PORT}/health`);
  console.log(`  Proxmox API:    ${apiBaseUrl()} (token ${process.env.PROXMOX_TOKEN_ID})`);
  console.log(`  Default node:   ${process.env.PROXMOX_NODE || "pve"}`);
  console.log(`  No-migrate tag: ${noMigrateTag()} (case-insensitive)`);
  // Fail-loud about missing configuration.
  const missing = ["PROXMOX_HOST", "PROXMOX_TOKEN_ID", "PROXMOX_TOKEN_SECRET"]
    .filter((name) => !process.env[name]);
  if (missing.length > 0) {
    console.error(
      `  ✗ ${missing.join(", ")} not set. Set them in .env / .env.local.`
    );
    process.exit(1);
  }
  if (tlsInsecure()) {
    console.warn(
      "  ⚠ PROXMOX_TLS_INSECURE=true; the Proxmox certificate is NOT verified. Set PROXMOX_CA_CERT to /etc/pve/pve-root-ca.pem instead."
    );
  }
  if (!MCP_AUTH_TOKEN) {
    console.warn(
      "  ⚠ MCP_AUTH_TOKEN is not set; the /mcp endpoint is UNAUTHENTICATED. Set MCP_AUTH_TOKEN to require a Bearer token."
    );
  }
});

// Cleanup on shutdown
process.on("SIGINT", () => {
  console.log("\nShutting down...");
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\nShutting down...");
  process.exit(0);
});