import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { pvesh, resolveGuest, waitForTask, asString, asObject, getNextVmid, ProxmoxError } from "../proxmox.js";
import { nodeParam, vmidParam, targetNodeParam } from "../schemas.js";

const DONT_MOVE_TAG = "dont-move";

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

/**
 * Perform a single guest migration to the target node.
 * Returns the final VMID (may differ from input for LXC clone fallback).
 */
async function performMigration(
  node: string,
  type: "qemu" | "lxc",
  vmid: number,
  target: string,
  bandwidth: number | undefined,
  targetStorage?: string,
  online?: boolean
): Promise<{ newVmid: number; method: "migrate" | "move" | "clone-fallback" }> {
  if (type === "qemu") {
    const params: Record<string, string | number | boolean> = {
      target,
      bandwidth: bandwidth ?? 150,
      online: 1,
    };
    if (targetStorage) params.target_storage = targetStorage;
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
      bwlimit: (bandwidth ?? 150) * 1024,
    };
    if (online) {
      params.online = 1;
    } else {
      params.restart = 1;
    }
    if (targetStorage) params.target_storage = targetStorage;
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
    const msg = err.message || String(err);
    if (!msg.includes("No 'create' handler") && !msg.includes("handler defined")) {
      throw err;
    }

    // Clone-based fallback: clone → start clone → stop original → delete original
    const config = asObject(
      await pvesh("get", `/nodes/${node}/lxc/${vmid}/config`)
    );
    const name = config?.hostname || `ct-${vmid}`;
    const newVmid = await getNextVmid();

    // Clone to target
    const cloneParams: Record<string, string | number | boolean> = {
      target,
      vmid: newVmid,
      name,
    };
    if (targetStorage) cloneParams.target_storage = targetStorage;
    const cloneResult = await pvesh(
      "create",
      `/nodes/${node}/lxc/${vmid}/clone`,
      cloneParams,
      600000
    );
    await waitForTask(target, asString(cloneResult), 600000);

    // Start the clone on target
    const startResult = await pvesh(
      "create",
      `/nodes/${target}/lxc/${newVmid}/status/start`,
      {},
      120000
    );
    await waitForTask(target, asString(startResult), 120000);

    // Stop the original
    const stopResult = await pvesh(
      "create",
      `/nodes/${node}/lxc/${vmid}/status/stop`,
      {},
      120000
    );
    await waitForTask(node, asString(stopResult), 120000);

    // Delete the original
    const delResult = await pvesh(
      "delete",
      `/nodes/${node}/lxc/${vmid}`,
      {},
      120000
    );
    await waitForTask(node, asString(delResult), 120000);

    return { newVmid, method: "clone-fallback" };
  }
}

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
        bandwidth: z
          .number()
          .default(150)
          .describe("Bandwidth limit in MB/s (QEMU only; default 150)"),
        target_storage: z
          .string()
          .optional()
          .describe("Target storage pool (if different from source)"),
        online: z
          .boolean()
          .default(false)
          .describe("Use live/online migration (QEMU: no downtime; LXC: experimental). LXC defaults to restart."),
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

      return {
        content: [
          {
            type: "text" as const,
            text: result.newVmid !== vmid
              ? `OK: Migrated ${type} VMID ${vmid} → ${result.newVmid} (clone) from '${guestNode}' to '${target_node}'.`
              : `OK: Migrated ${type} VMID ${vmid} from '${guestNode}' to '${target_node}'.`,
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
        bandwidth: z
          .number()
          .default(150)
          .describe("Per-migration bandwidth limit in MB/s (default 150)"),
        target_storage: z
          .string()
          .optional()
          .describe("Target storage pool (if different from source)"),
        dry_run: z
          .boolean()
          .default(false)
          .describe("Preview only: show what would be migrated/skipped without performing migrations"),
        online: z
          .boolean()
          .default(false)
          .describe("Use live/online migration (QEMU: no downtime; LXC: experimental). LXC defaults to restart."),
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