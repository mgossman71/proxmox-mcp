import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { pvesh, resolveGuest, waitForTask, asString, asObject, getNextVmid, ProxmoxError } from "../proxmox.js";
import { nodeParam, vmidParam, targetNodeParam } from "../schemas.js";

const DONT_MOVE_TAG = "dont-move";

/**
 * PVE's `bwlimit` is expressed in KiB/s on every migrate/clone endpoint, while
 * the tools take a friendlier MB/s value. Convert at the boundary.
 */
const KIB_PER_MB = 1024;

/**
 * Message fragments that indicate the endpoint we called does not exist on this
 * PVE version, as opposed to the operation itself failing. Matched
 * case-insensitively against both the error message and any captured stderr.
 *
 * Older PVE reports a missing handler; newer versions answer with a 501 or a
 * "no such resource" error instead, so all three shapes have to be covered or
 * the LXC clone fallback never runs on the clusters it exists for.
 */
const ENDPOINT_MISSING_PATTERNS = [
  "no 'create' handler",
  "handler defined",
  "not implemented",
  "no such resource",
  "unknown command",
  "501",
];

/**
 * Extract a human-readable error message from any thrown value.
 */
function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (typeof err === "object" && err !== null) {
    const o = err as any;
    if (typeof o.message === "string") return o.message;
    if (typeof o.stderr === "string") return o.stderr;
  }
  return JSON.stringify(err);
}

/**
 * True when the error looks like "this endpoint does not exist here" rather
 * than "the operation failed".
 */
function isEndpointMissing(err: unknown): boolean {
  const parts = [errMsg(err)];
  if (typeof err === "object" && err !== null) {
    const stderr = (err as any).stderr;
    if (typeof stderr === "string") parts.push(stderr);
  }
  const haystack = parts.join("\n").toLowerCase();
  return ENDPOINT_MISSING_PATTERNS.some((p) => haystack.includes(p));
}

/**
 * Read the tags field from a guest's config. Returns an array of tag strings.
 */
async function getGuestTags(
  node: string,
  type: "qemu" | "lxc",
  vmid: number
): Promise<string[]> {
  const raw = await pvesh("get", `/nodes/${node}/${type}/${vmid}/config`);
  const config = asObject(raw);
  if (!config) {
    throw new ProxmoxError(
      `Cannot verify tags for VMID ${vmid}: config read returned empty/null. ` +
        `Refusing to proceed (fail-closed).`
    );
  }
  const tags: string = config.tags ?? "";
  if (!tags) return [];
  return tags.split(/[;,]/).map((t) => t.trim()).filter(Boolean);
}

/**
 * Check if a guest has the "dont-move" tag. Throws if it does.
 */
export async function assertMovable(
  node: string,
  type: "qemu" | "lxc",
  vmid: number,
  name?: string
): Promise<void> {
  const tags = await getGuestTags(node, type, vmid);
  if (tags.includes(DONT_MOVE_TAG)) {
    const label = name ? `'${name}'` : "";
    throw new ProxmoxError(
      `Refusing to move VMID ${vmid} ${label}: tagged "${DONT_MOVE_TAG}". ` +
        `This guest uses fixed resources on its current chassis and must not be moved.`
    );
  }
}

interface MigrationResult {
  newVmid: number;
  method: "migrate" | "move" | "clone-fallback";
  /** True when a stopped copy of the source guest was deliberately left behind. */
  originalRetained?: boolean;
}

/**
 * Perform a single guest migration to the target node.
 * Returns the final VMID (may differ from input for LXC clone fallback).
 */
async function performMigration(
  node: string,
  type: "qemu" | "lxc",
  vmid: number,
  target: string,
  bandwidth: number,
  targetStorage?: string,
  online?: boolean
): Promise<MigrationResult> {
  const bwlimit = bandwidth * KIB_PER_MB;

  if (type === "qemu") {
    const params: Record<string, string | number | boolean> = {
      target,
      bwlimit,
      // QEMU migration defaults to live/online; only an explicit false opts out.
      online: online === false ? 0 : 1,
    };
    if (targetStorage) params.targetstorage = targetStorage;
    const result = await pvesh(
      "create",
      `/nodes/${node}/qemu/${vmid}/migrate`,
      params,
      600000
    );
    await waitForTask(node, asString(result), 600000);
    return { newVmid: vmid, method: "migrate" };
  }

  // LXC: try native move endpoint first (PVE 7.3+)
  try {
    const params: Record<string, string | number | boolean> = {
      target,
      bwlimit,
    };
    if (online) {
      params.online = 1;
    } else {
      params.restart = 1;
    }
    if (targetStorage) params["target-storage"] = targetStorage;
    const result = await pvesh(
      "create",
      `/nodes/${node}/lxc/${vmid}/migrate`,
      params,
      600000
    );
    await waitForTask(node, asString(result), 600000);
    return { newVmid: vmid, method: "move" };
  } catch (err: any) {
    // If the endpoint doesn't exist at all, fall back to clone-based approach
    if (!isEndpointMissing(err)) {
      throw err;
    }

    // Clone-based fallback: stop original → clone → start clone.
    //
    // The original is stopped *before* the clone so the copy is consistent and
    // the two containers never run concurrently with the same hostname/IP/MAC.
    // It is then left in place, stopped, for the operator to remove — this tool
    // does not delete guests.
    const config = asObject(
      await pvesh("get", `/nodes/${node}/lxc/${vmid}/config`)
    );
    const hostname = config?.hostname || `ct-${vmid}`;
    const newVmid = await getNextVmid();

    // Stop the original first, so the clone is consistent
    const status = asObject(
      await pvesh("get", `/nodes/${node}/lxc/${vmid}/status/current`)
    );
    if (status?.status === "running") {
      const stopResult = await pvesh(
        "create",
        `/nodes/${node}/lxc/${vmid}/status/stop`,
        {},
        120000
      );
      await waitForTask(node, asString(stopResult), 120000);
    }

    // Clone to target. The clone task is owned by the *source* node, so it must
    // be polled there — the target node cannot report on another node's UPID.
    const cloneParams: Record<string, string | number | boolean> = {
      target,
      newid: newVmid,
      hostname,
      full: 1,
    };
    if (targetStorage) cloneParams.storage = targetStorage;
    const cloneResult = await pvesh(
      "create",
      `/nodes/${node}/lxc/${vmid}/clone`,
      cloneParams,
      600000
    );
    await waitForTask(node, asString(cloneResult), 600000);

    // Start the clone on target
    const startResult = await pvesh(
      "create",
      `/nodes/${target}/lxc/${newVmid}/status/start`,
      {},
      120000
    );
    await waitForTask(target, asString(startResult), 120000);

    return { newVmid, method: "clone-fallback", originalRetained: true };
  }
}

/** Bandwidth limit shared by both migration tools. */
const bandwidthParam = z
  .number()
  .int()
  .positive()
  .default(150)
  .describe("Bandwidth limit in MB/s (default 150). Must be a positive integer.");

/**
 * Deliberately has no zod default: `undefined` is the signal that the caller
 * did not choose, which lets each guest type apply its own sensible default
 * (QEMU live, LXC restart) inside performMigration.
 */
const onlineParam = z
  .boolean()
  .optional()
  .describe(
    "Use live/online migration. Defaults to online for QEMU (no downtime) and " +
      "to restart for LXC (brief downtime; LXC live migration is experimental)."
  );

export function registerMigrationTools(server: McpServer): void {
  // migrate_guest
  server.registerTool(
    "migrate_guest",
    {
      title: "Migrate Guest",
      description:
        "Live migrate a QEMU VM or LXC container to another cluster node. " +
        "Refuses to migrate guests tagged with 'dont-move'. " +
        "The guest must currently be running on the source node.",
      inputSchema: {
        node: nodeParam,
        vmid: vmidParam,
        target_node: targetNodeParam,
        bandwidth: bandwidthParam,
        target_storage: z
          .string()
          .optional()
          .describe("Target storage pool (if different from source)"),
        online: onlineParam,
      },
    },
    async ({ node, vmid, target_node, bandwidth, target_storage, online }) => {
      const { node: guestNode, type } = await resolveGuest(node, vmid);

      if (guestNode === target_node) {
        throw new ProxmoxError(
          `VMID ${vmid} is already on node '${target_node}'. No migration needed.`
        );
      }

      await assertMovable(guestNode, type, vmid);

      const result = await performMigration(
        guestNode,
        type,
        vmid,
        target_node,
        bandwidth,
        target_storage,
        online
      );

      let text =
        result.newVmid !== vmid
          ? `OK: Migrated ${type} VMID ${vmid} → ${result.newVmid} (clone) from '${guestNode}' to '${target_node}'.`
          : `OK: Migrated ${type} VMID ${vmid} from '${guestNode}' to '${target_node}'.`;

      if (result.originalRetained) {
        text +=
          `\nNOTE: the source container ${vmid} was stopped and left in place on ` +
          `'${guestNode}'. Verify the copy, then remove the original yourself.`;
      }

      return {
        content: [
          {
            type: "text" as const,
            text,
          },
        ],
      };
    }
  );

  // drain_node
  server.registerTool(
    "drain_node",
    {
      title: "Drain Cluster Node",
      description:
        "Migrate all guests from one cluster node to another (for maintenance or decommissioning). " +
        "Automatically skips guests tagged 'dont-move'. " +
        "Migrations are performed sequentially to avoid saturating the network. " +
        "Use dry_run=true to preview what would be migrated without performing any migrations.",
      inputSchema: {
        source_node: nodeParam,
        target_node: targetNodeParam,
        bandwidth: bandwidthParam,
        target_storage: z
          .string()
          .optional()
          .describe("Target storage pool (if different from source)"),
        dry_run: z
          .boolean()
          .default(false)
          .describe("Preview only: show what would be migrated/skipped without performing migrations"),
        online: onlineParam,
      },
    },
    async ({ source_node, target_node, bandwidth, target_storage, dry_run, online }) => {
      if (source_node === target_node) {
        throw new ProxmoxError(
          `Source and target are the same node ('${source_node}'). Nothing to drain.`
        );
      }

      // Collect all guests on the source node
      const qemuList = await pvesh("get", `/nodes/${source_node}/qemu`);
      const lxcList = await pvesh("get", `/nodes/${source_node}/lxc`);

      const guests: { vmid: number; type: "qemu" | "lxc"; name: string }[] = [];

      if (Array.isArray(qemuList)) {
        for (const vm of qemuList) {
          if (typeof vm.vmid === "number" && vm.vmid > 0) {
            guests.push({ vmid: vm.vmid, type: "qemu", name: vm.name || `vm-${vm.vmid}` });
          }
        }
      }

      if (Array.isArray(lxcList)) {
        for (const ct of lxcList) {
          if (typeof ct.vmid === "number" && ct.vmid > 0) {
            guests.push({ vmid: ct.vmid, type: "lxc", name: ct.name || `ct-${ct.vmid}` });
          }
        }
      }

      if (guests.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Node '${source_node}' has no guests to drain.`,
            },
          ],
        };
      }

      // Check tags for each guest
      const toMigrate: typeof guests = [];
      const skipped: { vmid: number; type: string; name: string; reason: string }[] = [];
      const failed: { vmid: number; name: string; error: string }[] = [];

      for (const g of guests) {
        try {
          const tags = await getGuestTags(source_node, g.type, g.vmid);
          if (tags.includes(DONT_MOVE_TAG)) {
            skipped.push({ ...g, reason: "tagged 'dont-move'" });
          } else {
            toMigrate.push(g);
          }
        } catch (err) {
          failed.push({ vmid: g.vmid, name: g.name, error: errMsg(err) });
        }
      }

      // Dry run: just report the plan
      if (dry_run) {
        const lines: string[] = [];
        lines.push(`DRY RUN — No migrations performed.`);
        lines.push("");
        lines.push(`Would migrate (${toMigrate.length}):`);
        for (const g of toMigrate) {
          lines.push(`  ${g.vmid} (${g.type}) "${g.name}" → ${target_node}`);
        }
        if (skipped.length > 0) {
          lines.push("");
          lines.push(`Skipped — tagged "dont-move" (${skipped.length}):`);
          for (const s of skipped) {
            lines.push(`  ${s.vmid} (${s.type}) "${s.name}"`);
          }
        }
        // Guests whose tag check failed cannot be planned either way. Reporting
        // them here keeps the preview an honest account of the whole node.
        if (failed.length > 0) {
          lines.push("");
          lines.push(`Cannot determine — tag check failed (${failed.length}):`);
          for (const f of failed) {
            lines.push(`  ${f.vmid} "${f.name}": ${f.error}`);
          }
          lines.push("");
          lines.push(
            `These guests would NOT be migrated; '${source_node}' would not be fully evacuated.`
          );
        }
        return {
          content: [
            {
              type: "text" as const,
              text: lines.join("\n"),
            },
          ],
        };
      }

      // Perform migrations sequentially
      const migrated: string[] = [];
      const retained: number[] = [];

      for (const g of toMigrate) {
        try {
          const result = await performMigration(
            source_node,
            g.type,
            g.vmid,
            target_node,
            bandwidth,
            target_storage,
            online
          );
          if (result.newVmid !== g.vmid) {
            migrated.push(`${g.vmid} → ${result.newVmid} (${g.type}) "${g.name}" [clone]`);
          } else {
            migrated.push(`${g.vmid} (${g.type}) "${g.name}"`);
          }
          if (result.originalRetained) retained.push(g.vmid);
        } catch (err: any) {
          failed.push({
            vmid: g.vmid,
            name: g.name,
            error: errMsg(err),
          });
        }
      }

      // Build summary
      const summary: string[] = [];
      summary.push(`Drain of node '${source_node}' → '${target_node}' complete.`);
      summary.push("");
      summary.push(`  Migrated: ${migrated.length}`);
      summary.push(`  Skipped (dont-move): ${skipped.length}`);
      summary.push(`  Failed: ${failed.length}`);

      if (migrated.length > 0) {
        summary.push("");
        summary.push("  Successfully migrated:");
        for (const m of migrated) {
          summary.push(`    ✓ ${m}`);
        }
      }

      if (skipped.length > 0) {
        summary.push("");
        summary.push("  Skipped (tagged 'dont-move'):");
        for (const s of skipped) {
          summary.push(`    ⊘ ${s.vmid} (${s.type}) "${s.name}"`);
        }
      }

      if (failed.length > 0) {
        summary.push("");
        summary.push("  Failed:");
        for (const f of failed) {
          summary.push(`    ✗ ${f.vmid} "${f.name}": ${f.error}`);
        }
      }

      if (retained.length > 0) {
        summary.push("");
        summary.push(
          `  Stopped originals left in place on '${source_node}' (clone fallback): ${retained.join(", ")}`
        );
        summary.push("  Verify the copies, then remove the originals yourself.");
      }

      return {
        content: [
          {
            type: "text" as const,
            text: summary.join("\n"),
          },
        ],
      };
    }
  );
}
