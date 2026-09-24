import { execFile } from "child_process";
import { promisify } from "util";
import os from "os";

const execFileAsync = promisify(execFile);

const SSH_HOST = process.env.PROXMOX_SSH_HOST;
const SSH_USER = process.env.PROXMOX_SSH_USER || "root";
const SSH_KEY = expandHome(
  process.env.PROXMOX_SSH_KEY || "~/.ssh/id_rsa"
);

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
 * Error raised when a pvesh response cannot be parsed into JSON.
 *
 * Kept as a distinct subclass (rather than matching on the message string) so
 * callers such as `waitForTask` can reliably tell a transient parse hiccup
 * apart from a genuine Proxmox/SSH failure.
 */
export class ProxmoxParseError extends ProxmoxError {
  constructor(message: string) {
    super(message);
    this.name = "ProxmoxParseError";
  }
}

/**
 * Shape of the value returned by {@link pvesh}: a parsed JSON object or array,
 * a raw UPID/progress string, or `null` when the command produced no output.
 */
export type PveshResult = Record<string, any> | any[] | string | null;

/**
 * Run a command on the Proxmox host via SSH.
 */
async function ssh(remoteCmd: string, timeoutMs = 60000): Promise<string> {
  // Reuse a single multiplexed SSH connection across calls (ControlMaster).
  // This avoids re-establishing the TCP + auth handshake for every pvesh call,
  // which matters for compound operations (e.g. list_isos over N storages).
  // ControlPersist keeps the master connection alive briefly between requests.
  const controlPath = `${os.tmpdir()}/proxmox-mcp-ssh-%r@%h:%p`;
  const args = [
    "-o", "BatchMode=yes",
    // accept-new: trust the host key on first contact, then pin it — avoids the
    // silent MITM exposure of "no" while still working for brand-new hosts.
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=10",
    "-o", "ControlMaster=auto",
    "-o", `ControlPath=${controlPath}`,
    "-o", "ControlPersist=300",
    "-i", SSH_KEY,
    `${SSH_USER}@${SSH_HOST}`,
    remoteCmd,
  ];

  try {
    const { stdout } = await execFileAsync("ssh", args, {
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error: any) {
    const stderr = error.stderr?.trim() || error.message || "Unknown SSH error";
    throw new ProxmoxError(
      `SSH command failed (exit ${error.code ?? "?"}): ${stderr}`,
      error.code ?? 1,
      stderr
    );
  }
}

/**
 * Shell-quote a string for safe use in a remote shell command.
 */
function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Run a pvesh command on the Proxmox host.
 *
 * @param method  - pvesh method: get, create, set, delete
 * @param path    - API path (e.g. /nodes/pve/qemu/100/config)
 * @param params  - key-value parameters (e.g. { name: "MyVM", cores: 2 })
 * @returns parsed JSON response, or null if empty
 */
export async function pvesh(
  method: "get" | "create" | "set" | "delete",
  path: string,
  params: Record<string, string | number | boolean> = {},
  timeoutMs = 60000
): Promise<PveshResult> {
  let cmd = `pvesh ${method} ${path}`;

  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "boolean") {
      if (value) cmd += ` --${key} 1`;
    } else {
      cmd += ` --${key} ${q(String(value))}`;
    }
  }

  cmd += " --output-format json";

  const output = await ssh(cmd, timeoutMs);

  if (!output) return null;

  try {
    return JSON.parse(output);
  } catch {
    // pvesh may return multi-line output with progress messages
    // followed by a UPID on the last line. Extract it.
    const lines = output.split("\n").filter((l) => l.trim());
    const lastLine = lines[lines.length - 1]?.trim();

    if (lastLine && lastLine.startsWith("UPID:")) {
      return lastLine;
    }

    // Check if any line is valid JSON (e.g., JSON followed by extra output)
    for (const line of lines) {
      try {
        return JSON.parse(line);
      } catch {
        continue;
      }
    }

    throw new ProxmoxParseError(
      `Failed to parse pvesh response: ${output}`
    );
  }
}

/**
 * Get the node name and guest type (qemu/lxc) for a given vmid.
 */
export async function getGuestInfo(
  vmid: number
): Promise<{ node: string; type: "qemu" | "lxc"; name: string }> {
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
    await pvesh("get", `/nodes/${node}/qemu/${vmid}/status/current`);
    return { node, type: "qemu" };
  } catch { /* not a QEMU VM on this node */ }

  try {
    await pvesh("get", `/nodes/${node}/lxc/${vmid}/status/current`);
    return { node, type: "lxc" };
  } catch { /* not an LXC container on this node */ }

  const info = await getGuestInfo(vmid);
  return { node: info.node, type: info.type };
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
        await pvesh("get", `/nodes/${node}/tasks/${upid}/status`)
      );
      if (status && status.status === "stopped") {
        if (status.exitstatus === "OK") {
          return;
        }
        // Task failed — try to get the log for the actual error message
        let detail = `exitstatus=${status.exitstatus}`;
        try {
          const log = await pvesh("get", `/nodes/${node}/tasks/${upid}/log`);
          if (log != null) {
            const lines: any[] = Array.isArray(log) ? log : [log];
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