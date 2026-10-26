import https from "https";
import fs from "fs";
import os from "os";

export function expandHome(path: string): string {
  if (path.startsWith("~")) {
    return path.replace("~", os.homedir());
  }
  return path;
}

export class ProxmoxError extends Error {
  constructor(
    message: string,
    public exitCode: number = 1,
    public stderr: string = ""
  ) {
    super(message);
    this.name = "ProxmoxError";
  }
}

/**
 * Error raised when a Proxmox API response cannot be parsed into JSON.
 *
 * Kept as a distinct subclass (rather than matching on the message string) so
 * callers such as `waitForTask` can reliably tell a transient parse hiccup
 * apart from a genuine Proxmox/API failure.
 */
export class ProxmoxParseError extends ProxmoxError {
  constructor(message: string) {
    super(message);
    this.name = "ProxmoxParseError";
  }
}

/**
 * Shape of the value returned by {@link pvesh}: a parsed JSON object or array,
 * a UPID string, or `null` when the API returned no data.
 */
export type PveshResult = Record<string, any> | any[] | string | null;

/** True when TLS certificate verification has been explicitly disabled. */
export function tlsInsecure(): boolean {
  return process.env.PROXMOX_TLS_INSECURE?.toLowerCase() === "true";
}

/** Base URL of the Proxmox API, e.g. `https://10.0.0.19:8006/api2/json`. */
export function apiBaseUrl(): string {
  const port = process.env.PROXMOX_PORT || "8006";
  return `https://${process.env.PROXMOX_HOST}:${port}/api2/json`;
}

// One keep-alive agent for every request. This reuses the TLS connection
// across calls, which matters for compound operations (e.g. list_isos over N
// storages). Built lazily so configuration is read after dotenv has loaded.
let agent: https.Agent | undefined;

function getAgent(): https.Agent {
  if (!agent) {
    const caPath = process.env.PROXMOX_CA_CERT;
    agent = new https.Agent({
      keepAlive: true,
      ca: caPath ? fs.readFileSync(expandHome(caPath)) : undefined,
      rejectUnauthorized: !tlsInsecure(),
    });
  }
  return agent;
}

interface HttpResponse {
  status: number;
  statusText: string;
  body: string;
}

/**
 * Send one HTTPS request to the Proxmox API.
 */
function request(
  method: string,
  url: string,
  body: string | undefined,
  timeoutMs: number
): Promise<HttpResponse> {
  const headers: Record<string, string> = {
    Authorization: `PVEAPIToken=${process.env.PROXMOX_TOKEN_ID}=${process.env.PROXMOX_TOKEN_SECRET}`,
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    headers["Content-Length"] = String(Buffer.byteLength(body));
  }

  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      { method, headers, agent: getAgent(), timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            statusText: res.statusMessage ?? "",
            body: Buffer.concat(chunks).toString("utf8"),
          })
        );
        res.on("error", reject);
      }
    );
    req.on("timeout", () =>
      req.destroy(new Error(`Request timed out after ${timeoutMs} ms`))
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const HTTP_METHODS = {
  get: "GET",
  create: "POST",
  set: "PUT",
  delete: "DELETE",
} as const;

/**
 * Call the Proxmox VE REST API.
 *
 * Keeps the `pvesh` verb names (get/create/set/delete) so call sites read the
 * same as the Proxmox CLI docs; they map to GET/POST/PUT/DELETE.
 *
 * @param method  - pvesh method: get, create, set, delete
 * @param path    - API path (e.g. /nodes/pve/qemu/100/config)
 * @param params  - key-value parameters (e.g. { name: "MyVM", cores: 2 })
 * @returns the response's `data` field, or null if there is none
 */
export async function pvesh(
  method: "get" | "create" | "set" | "delete",
  path: string,
  params: Record<string, string | number | boolean> = {},
  timeoutMs = 60000
): Promise<PveshResult> {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    form.append(key, typeof value === "boolean" ? (value ? "1" : "0") : String(value));
  }
  const encoded = form.toString();

  const httpMethod = HTTP_METHODS[method];
  const hasBody = httpMethod === "POST" || httpMethod === "PUT";
  let url = `${apiBaseUrl()}${path}`;
  if (!hasBody && encoded) url += `?${encoded}`;

  let res: HttpResponse;
  try {
    res = await request(httpMethod, url, hasBody ? encoded : undefined, timeoutMs);
  } catch (error: any) {
    const message = error?.message || "Unknown network error";
    throw new ProxmoxError(`Proxmox API request failed: ${message}`, 1, message);
  }

  if (res.status < 200 || res.status >= 300) {
    // PVE puts the human-readable reason in the status line (e.g. "Permission
    // check failed (/vms/100, VM.Audit)") and per-parameter problems in
    // `errors`. Keep the status code in the text: isEndpointMissing() matches
    // on "501".
    let detail = "";
    try {
      const errors = JSON.parse(res.body)?.errors;
      if (errors) detail = ` ${JSON.stringify(errors)}`;
    } catch { /* non-JSON error body */ }
    throw new ProxmoxError(
      `HTTP ${res.status}: ${res.statusText}${detail}`,
      res.status,
      res.body
    );
  }

  if (!res.body) return null;

  let parsed: any;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    throw new ProxmoxParseError(
      `Failed to parse Proxmox API response: ${res.body}`
    );
  }
  return parsed?.data ?? null;
}

/**
 * Get the node name and guest type (qemu/lxc) for a given vmid.
 */
export async function getGuestInfo(
  vmid: number
): Promise<{ node: string; type: "qemu" | "lxc"; name: string; running: boolean }> {
  const resources = await pvesh("get", "/cluster/resources");
  if (!Array.isArray(resources)) {
    throw new ProxmoxError("Unexpected (non-array) response from /cluster/resources");
  }
  const match = resources.find(
    (r: any) => r.vmid === vmid && (r.type === "qemu" || r.type === "lxc")
  );
  if (!match) {
    throw new ProxmoxError(`VMID ${vmid} not found in cluster`);
  }
  return {
    node: match.node,
    type: match.type,
    name: match.name,
    running: match.status === "running",
  };
}

/**
 * Get the next available VMID in the cluster.
 */
export async function getNextVmid(): Promise<number> {
  const resources = await pvesh("get", "/cluster/resources");
  if (!Array.isArray(resources)) {
    throw new ProxmoxError("Unexpected (non-array) response from /cluster/resources");
  }
  const vmids = resources
    .filter((r: any) => typeof r.vmid === "number")
    .map((r: any) => r.vmid);
  if (vmids.length === 0) return 100;
  return Math.max(...vmids) + 1;
}

/**
 * Where (node) and what kind (qemu/lxc) a guest is.
 */
export interface GuestLocation {
  node: string;
  type: "qemu" | "lxc";
  /** True when the guest is currently running. Drives live vs offline migration. */
  running: boolean;
}

/**
 * Resolve which node and guest type a vmid belongs to.
 *
 * Shared by the lifecycle, snapshot, and inspection tools. Tries the requested
 * node first (QEMU then LXC) and falls back to a cluster-wide search, so callers
 * can both build the correct API path and poll tasks on the *correct* node.
 */
export async function resolveGuest(
  node: string,
  vmid: number
): Promise<GuestLocation> {
  try {
    const status = asObject(
      await pvesh("get", `/nodes/${node}/qemu/${vmid}/status/current`)
    );
    return { node, type: "qemu", running: status?.status === "running" };
  } catch { /* not a QEMU VM on this node */ }

  try {
    const status = asObject(
      await pvesh("get", `/nodes/${node}/lxc/${vmid}/status/current`)
    );
    return { node, type: "lxc", running: status?.status === "running" };
  } catch { /* not an LXC container on this node */ }

  const info = await getGuestInfo(vmid);
  return { node: info.node, type: info.type, running: info.running };
}

/**
 * Generate a random MAC address with the local OUI prefix.
 */
export function generateMac(): string {
  const bytes = Array.from({ length: 3 }, () =>
    Math.floor(Math.random() * 256)
  );
  // Use a locally administered unicast MAC (second LSB of first octet = 0)
  bytes[0] = (bytes[0] | 0x02) & 0xfe;
  const suffix = bytes
    .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
    .join(":");
  return `BC:24:11:${suffix}`;
}

/**
 * Narrow a {@link PveshResult} to a plain object, or `null` if it is an array,
 * a string, or null. Used to safely read fields off object-shaped responses.
 */
export function asObject(value: PveshResult): Record<string, any> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, any>;
  }
  return null;
}

/**
 * Narrow a {@link PveshResult} to a string (e.g. a UPID), or `null`. Used to
 * feed task IDs into {@link waitForTask}, which accepts `string | null`.
 */
export function asString(value: PveshResult): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Wait for a Proxmox task (identified by UPID) to complete.
 * If the task fails, throws a ProxmoxError with the failure details.
 * If the result is null/undefined/empty (no task was created), returns immediately.
 */
export async function waitForTask(
  node: string,
  upid: string | null | undefined,
  timeoutMs = 300000
): Promise<void> {
  if (!upid || typeof upid !== "string" || !upid.startsWith("UPID:")) {
    return;
  }

  const startTime = Date.now();
  const pollInterval = 2000;

  while (Date.now() - startTime < timeoutMs) {
    try {
      const status = asObject(
        await pvesh("get", `/nodes/${node}/tasks/${encodeURIComponent(upid)}/status`)
      );
      if (status && status.status === "stopped") {
        if (status.exitstatus === "OK") {
          return;
        }
        // Task failed — try to get the log for the actual error message
        let detail = `exitstatus=${status.exitstatus}`;
        try {
          const log = await pvesh("get", `/nodes/${node}/tasks/${encodeURIComponent(upid)}/log`);
          if (log != null) {
            // The API returns log lines as { n: lineNo, t: text }
            const lines: any[] = (Array.isArray(log) ? log : [log]).map(
              (l: any) => (typeof l === "object" && l !== null && "t" in l ? l.t : l)
            );
            // Take the last few lines as they usually contain the error
            const tail = lines.slice(-5).join("\n");
            if (tail) detail = tail;
          }
        } catch {
          // Couldn't fetch log, use what we have
        }
        throw new ProxmoxError(`Task ${upid} failed: ${detail}`);
      }
    } catch (e: any) {
      if (e instanceof ProxmoxError && !(e instanceof ProxmoxParseError)) {
        throw e;
      }
      // Transient parse error or task not yet queryable — keep polling
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  throw new ProxmoxError(`Timed out waiting for task ${upid} to complete`);
}