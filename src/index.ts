import { randomUUID } from "crypto";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";
import { bearerAuth } from "./auth.js";

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
  console.log(`  SSH target:     ${process.env.PROXMOX_SSH_USER || "root"}@${process.env.PROXMOX_SSH_HOST}`);
  // Fail-loud about missing configuration.
  if (!process.env.PROXMOX_SSH_HOST) {
    console.error(
      "  ✗ PROXMOX_SSH_HOST is not set. Set it in your .env file."
    );
    process.exit(1);
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