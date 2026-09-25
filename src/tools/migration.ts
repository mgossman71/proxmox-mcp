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
  /** True when the guest had to be shut down and restarted to move it. */
  restarted?: boolean;
}

/** Shut a guest down cleanly and wait for it to stop. */
async function shutdownGuest(
  node: string,
  type: "qemu" | "lxc",
  vmid: number
): Promise<void> {
  const result = await pvesh(
    "create",
    `/nodes/${node}/${type}/${vmid}/status/shutdown`,
    {},
    300000
  );
  await waitForTask(node, asString(result), 300000);
}

/** Start a guest and wait for it to come up. */
async function startGuest(
  node: string,
  type: "qemu" | "lxc",
  vmid: number
): Promise<void> {
  const result = await pvesh(
    "create",
    `/nodes/${node}/${type}/${vmid}/status/start`,
    {},
    120000
  );
  await waitForTask(node, asString(result), 120000);
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
  running: boolean,
  targetStorage?: string,
  online?: boolean
): Promise<MigrationResult> {
  const bwlimit = bandwidth * KIB_PER_MB;

  if (type === "qemu") {
    const base: Record<string, string | number | boolean> = { target, bwlimit };
    if (targetStorage) base.targetstorage = targetStorage;

    const migrate = async (params: Record<string, string | number | boolean>) => {
      const result = await pvesh(
        "create",
        `/nodes/${node}/qemu/${vmid}/migrate`,
        params,
        600000
      );
      await waitForTask(node, asString(result), 600000);
    };

    // Stopped stays stopped: move it offline and leave it that way.
    if (!running) {
      await migrate({ ...base, online: 0 });
      return { newVmid: vmid, method: "migrate" };
    }

    // Running: live migrate if we can, since that keeps the guest up.
    if (online !== false) {
      try {
        await migrate({ ...base, online: 1 });
        return { newVmid: vmid, method: "migrate" };
      } catch {
        // Live migration is not possible for this guest (local devices, CPU
        // mismatch, unshared storage...). Fall through and move it the slow
        // way rather than leaving it where it is.
      }
    }

    // Live migration is out, but the guest was running and must end up running:
    // shut it down, move it offline, start it on the target.
    await shutdownGuest(node, "qemu", vmid);
    try {
      await migrate({ ...base, online: 0 });
    } catch (err: any) {
      // The move failed, so the guest is still on the source node -- put it
      // back the way we found it rather than leaving it down.
      try {
        await startGuest(node, "qemu", vmid);
      } catch {
        throw new ProxmoxError(
          `Migration of VMID ${vmid} failed after shutdown (${errMsg(err)}), ` +
            `and it could not be restarted on '${node}'. It is stopped there.`
        );
      }
      throw new ProxmoxError(
        `Migration of VMID ${vmid} failed (${errMsg(err)}). It has been ` +
          `restarted on '${node}' and is running as before.`
      );
    }
    await startGuest(target, "qemu", vmid);
    return { newVmid: vmid, method: "migrate", restarted: true };
  }

  // LXC: try native move endpoint first (PVE 7.3+)
  try {
    const base: Record<string, string | number | boolean> = { target, bwlimit };
    if (targetStorage) base["target-storage"] = targetStorage;

    const migrate = async (params: Record<string, string | number | boolean>) => {
      const result = await pvesh(
        "create",
        `/nodes/${node}/lxc/${vmid}/migrate`,
        params,
        600000
      );
      await waitForTask(node, asString(result), 600000);
    };

    // Both flags describe what to do with a *running* container. A stopped one
    // migrates plainly and stays stopped; sending either would have PVE reject
    // the request.
    if (!running) {
      await migrate(base);
      return { newVmid: vmid, method: "move" };
    }

    // Live migration only when explicitly asked for: it is experimental for
    // LXC, so it is not what a caller gets by default.
    if (online) {
      try {
        await migrate({ ...base, online: 1 });
        return { newVmid: vmid, method: "move" };
      } catch (err: any) {
        // A missing endpoint is not a live-migration failure -- let the clone
        // fallback below handle it.
        if (isEndpointMissing(err)) throw err;
        // Otherwise live migration is not possible here; restart instead.
      }
    }

    // restart=1 is PVE's own shutdown → move → start, so the container ends up
    // running on the target as it was on the source.
    await migrate({ ...base, restart: 1 });
    return { newVmid: vmid, method: "move", restarted: true };
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

    // Stop the original first, so the clone is consistent. This read is also
    // what decides whether the clone gets started, so the container ends up in
    // the same run state it started in.
    const status = asObject(
      await pvesh("get", `/nodes/${node}/lxc/${vmid}/status/current`)
    );
    const wasRunning = status?.status === "running";
    if (wasRunning) {
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

    // Start the clone only if the original was running -- a stopped container
    // must not come back up on the target.
    if (wasRunning) {
      await startGuest(target, "lxc", newVmid);
    }

    return {
      newVmid,
      method: "clone-fallback",
      originalRetained: true,
      restarted: wasRunning,
    };
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
    "Whether to attempt live migration of a *running* guest: on by default for " +
      "QEMU (no downtime), off by default for LXC (live migration is " +
      "experimental there). When live migration is not used or not possible, " +
      "the guest is shut down, moved and started again, so it still ends up " +
      "running. Ignored for stopped guests, which always migrate offline and " +
      "stay stopped."
  );

export function registerMigrationTools(server: McpServer): void {
  // migrate_guest
  server.registerTool(
    "migrate_guest",
    {
      title: "Migrate Guest",
      description:
        "Migrate a QEMU VM or LXC container to another cluster node. " +
        "Refuses to migrate guests tagged with 'dont-move'. " +
        "The guest's run state is preserved: a stopped guest is moved offline " +
        "and left stopped, and a running guest ends up running on the target — " +
        "live-migrated if possible, otherwise shut down, moved and started " +
        "again. There is no need to start or stop a guest before or after " +
        "calling this — do not issue start_guest or stop_guest to 'restore' a " +
        "guest's run state, as it is already preserved.",
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
      const { node: guestNode, type, running } = await resolveGuest(node, vmid);

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
        running,
        target_storage,
        online
      );

      let text =
        result.newVmid !== vmid
          ? `OK: Migrated ${type} VMID ${vmid} → ${result.newVmid} (clone) from '${guestNode}' to '${target_node}'.`
          : `OK: Migrated ${type} VMID ${vmid} from '${guestNode}' to '${target_node}'.`;

      // Say the run state outright. Without this the caller only sees "migrated"
      // and may decide for itself that the guest needs starting -- which is how
      // a deliberately-stopped guest gets "restored" into running.
      const moved = result.newVmid !== vmid ? result.newVmid : vmid;
      if (running && result.restarted) {
        text +=
          `\nRun state preserved: ${vmid} was running, and live migration was ` +
          `not possible, so it was shut down, moved, and started again. ` +
          `${moved} is RUNNING on '${target_node}'.`;
      } else if (running) {
        text +=
          `\nRun state preserved: ${vmid} was running and was live migrated. ` +
          `${moved} is RUNNING on '${target_node}'. There was no downtime.`;
      } else {
        text +=
          `\nRun state preserved: ${vmid} was STOPPED before the migration and ` +
          `is STOPPED on '${target_node}'. This is deliberate — it was moved ` +
          `offline and intentionally not started. Do not start it to "restore" ` +
          `it; it is already in the state it was found in.`;
      }

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
        "Each guest's run state is preserved: stopped guests stay stopped, running guests end up running. " +
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

      const guests: {
        vmid: number;
        type: "qemu" | "lxc";
        name: string;
        running: boolean;
      }[] = [];

      if (Array.isArray(qemuList)) {
        for (const vm of qemuList) {
          if (typeof vm.vmid === "number" && vm.vmid > 0) {
            guests.push({
              vmid: vm.vmid,
              type: "qemu",
              name: vm.name || `vm-${vm.vmid}`,
              running: vm.status === "running",
            });
          }
        }
      }

      if (Array.isArray(lxcList)) {
        for (const ct of lxcList) {
          if (typeof ct.vmid === "number" && ct.vmid > 0) {
            guests.push({
              vmid: ct.vmid,
              type: "lxc",
              name: ct.name || `ct-${ct.vmid}`,
              running: ct.status === "running",
            });
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
            g.running,
            target_storage,
            online
          );
          const state = g.running ? "running" : "stopped";
          if (result.newVmid !== g.vmid) {
            migrated.push(
              `${g.vmid} → ${result.newVmid} (${g.type}) "${g.name}" [clone] — ${state}`
            );
          } else {
            migrated.push(`${g.vmid} (${g.type}) "${g.name}" — ${state}`);
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
        summary.push("  Successfully migrated (run state preserved — each guest");
        summary.push("  is in the state shown, which is the state it started in;");
        summary.push("  do not start or stop any of them to 'restore' them):");
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
