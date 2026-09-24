import { z } from "zod";

/**
 * Strict pattern for Proxmox API path segments (node names, storage pool names).
 *
 * These values are interpolated directly into the `pvesh` API path that is
 * executed on the remote host over SSH. Restricting them to a safe character
 * set (alphanumerics plus `-` and `_`, and not starting with a separator)
 * prevents shell/path injection. The MCP SDK validates tool input against these
 * schemas before the handler runs, so a hostile value such as `pve; reboot` is
 * rejected at the boundary and never reaches the remote shell.
 */
const SAFE_PATH_SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

const SEGMENT_MESSAGE =
  "must be alphanumeric and may contain '-' or '_', and must not start with a separator (e.g. 'pve' or 'local-lvm')";

/** Proxmox node name. Defaults to `pve` when omitted. */
export const nodeParam = z
  .string()
  .regex(SAFE_PATH_SEGMENT, `Node name ${SEGMENT_MESSAGE}`)
  .default(process.env.PROXMOX_NODE || "pve")
  .describe("Proxmox node name");

/** Storage pool name (no default — required where used). */
export const storageParam = z
  .string()
  .regex(SAFE_PATH_SEGMENT, `Storage name ${SEGMENT_MESSAGE}`)
  .describe("Storage pool name (e.g. 'local', 'local-lvm')");

/** VM or container ID. */
export const vmidParam = z.number().describe("VM or container ID");