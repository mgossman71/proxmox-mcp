# Proxmox MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io/) server for managing [Proxmox VE](https://www.proxmox.com/) clusters. Connects to Proxmox via SSH and uses `pvesh` for all API operations.

## Architecture

```
Claude / Cline (MCP Client)
    ↕ HTTP (Streamable HTTP transport)
Proxmox MCP Server (Docker container)
    ↕ SSH (key-based auth)
Proxmox VE (pvesh)
```

## Prerequisites

- Proxmox VE 8.x or later (tested on 9.2)
- Your SSH public key added to the Proxmox host (`~/.ssh/authorized_keys`)
- Docker + Docker Compose

## Setup

### 1. SSH Key

Ensure your SSH public key is on the Proxmox host:

```bash
ssh-copy-id root@<proxmox-ip>
```

### 2. Configure

Create a .env file with your Proxmox SSH details (required — the app will not start without PROXMOX_SSH_HOST):


```env
PROXMOX_SSH_HOST=10.0.0.19
PROXMOX_SSH_USER=root
PROXMOX_SSH_KEY=~/.ssh/id_rsa
MCP_PORT=3000

# Optional but strongly recommended — see Authentication below.
MCP_AUTH_TOKEN=some-long-random-string

# Default node for tools called without an explicit `node` (default: pve).
PROXMOX_NODE=pve

# Tag that marks a guest as un-migratable (default: dont-move).
# Matched case-insensitively. A blank value falls back to the default rather
# than disabling the protection.
PROXMOX_NO_MIGRATE_TAG=dont-move
```

`MCP_PORT` is the **host** port; the container always listens on 3000 internally.

### 3. Authentication

`/mcp` is protected by a shared-secret Bearer token. Set `MCP_AUTH_TOKEN` and
every request must carry `Authorization: Bearer <token>`; anything else gets a
401.

**If `MCP_AUTH_TOKEN` is unset the endpoint is completely unauthenticated** —
anyone who can reach the port can create and destroy guests on your cluster. The
server logs a warning at startup when this is the case. It is left optional so
local development stays frictionless, but do not run it this way on a network
you do not trust.

`/health` is deliberately left open so orchestrators can probe it without
credentials.

### 4. Run

```bash
docker compose up -d
```

Verify:

```bash
curl http://localhost:3000/health
# {"status":"ok","service":"proxmox-mcp"}
```

### 5. Connect MCP Client

**Cline / VS Code** and **Claude Desktop** use the same shape:

```json
{
  "mcpServers": {
    "proxmox": {
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer some-long-random-string"
      }
    }
  }
}
```

Drop the `headers` block if `MCP_AUTH_TOKEN` is unset.

Two things that make a client look broken when the server is fine:

- **`Accept` header.** Streamable HTTP requires the client to accept *both*
  `application/json` and `text/event-stream`. Sending only the former gets
  `406 Not Acceptable`.
- **Stale session after a restart.** Sessions are held in memory, so restarting
  the server invalidates every session ID. A client reusing an old one gets
  `400 Bad Request: Server not initialized` and must re-initialize — restart the
  client, do not just retry.

## Tools

> **Scope note:** All lifecycle and power operations target **guests** (QEMU VMs or LXC containers) only. This server does **not** expose physical host power management (node shutdown/reboot) or destructive guest deletion operations. Guests tagged `dont-move` are protected from migration and cross-node cloning. That tag is configurable via `PROXMOX_NO_MIGRATE_TAG` and is matched **case-insensitively**, so `DONT-MOVE` and `Dont-Move` protect a guest just as well.

### Inspection
| Tool | Description |
|------|-------------|
| `list_nodes` | Cluster nodes with status, CPU, memory |
| `list_resources` | All resources (VMs, containers, storage, SDN) |
| `list_vms` | QEMU VMs on a node |
| `list_containers` | LXC containers on a node |
| `get_guest_status` | Live status of a VM/container |
| `get_guest_config` | Full VM/container configuration |
| `list_storage` | Storage pools with usage |
| `list_storage_content` | Files/images in a storage pool |
| `list_isos` | Available ISO files |
| `list_lxc_templates` | Available LXC container templates |
| `list_tasks` | Recent tasks on a node |

### Lifecycle
| Tool | Description |
|------|-------------|
| `start_guest` | Start a VM or container |
| `stop_guest` | Force-stop a VM or container |
| `shutdown_guest` | Graceful shutdown |
| `reboot_guest` | Reboot |
| `suspend_guest` | Suspend (freeze in memory) |
| `resume_guest` | Resume from suspended |

### Snapshots
| Tool | Description |
|------|-------------|
| `list_snapshots` | List snapshots |
| `create_snapshot` | Create a snapshot |

### Provisioning
| Tool | Description |
|------|-------------|
| `create_vm` | Create a QEMU VM from an ISO |
| `create_container` | Create an LXC container from a template |
| `clone_guest` | Clone a VM or container (cross-node clones refused for guests carrying the no-migrate tag) |
| `set_guest_config` | Modify VM/container settings (CPU, memory, swap (LXC), name, onboot) |

### Migration
| Tool | Description |
|------|-------------|
| `migrate_guest` | Migrate a QEMU VM or LXC container to another node (running or stopped) |
| `drain_node` | Migrate all guests off a node (for maintenance/decommission) |

`bandwidth` is given in **MB/s** on both tools and is converted to PVE's KiB/s
`bwlimit` internally.

**Protected guests.** `migrate_guest` refuses, and `drain_node` skips, any guest
carrying the no-migrate tag — `dont-move` by default, or whatever you set
`PROXMOX_NO_MIGRATE_TAG` to. Matching ignores case. The check is *fail-closed*:
if a guest's config cannot be read, it is refused rather than moved, and
`drain_node` reports it as a guest that would leave the node not fully
evacuated.

**Run state is preserved.** A guest ends a migration in the state it started in,
and a guest never needs to be started or stopped first:

| Guest was | What happens | Guest ends up |
|-----------|--------------|---------------|
| Stopped | Moved offline | Stopped on the target |
| Running, live migration possible | Live migrated | Running, no downtime |
| Running, live migration not possible | Shut down → moved → started | Running, brief downtime |

`online` controls only whether live migration is *attempted* for a running
guest: on by default for QEMU, off by default for LXC (live migration is
experimental there, so `online: true` opts in). Either way a running guest ends
up running — `online: false` means "don't live migrate", not "leave it off". The
option is ignored for stopped guests.

If the move fails after the guest has been shut down, it is started again on the
source node so it is left as it was found. If that restart also fails, the tool
says so explicitly and names the node it is stopped on.

The tool output always names the run state on both sides, for example:

```
OK: Migrated lxc VMID 132 from 'pve3' to 'pve2'.
Run state preserved: 132 was STOPPED before the migration and is STOPPED on
'pve2'. This is deliberate — it was moved offline and intentionally not
started. Do not start it to "restore" it; it is already in the state it was
found in.
```

Do **not** follow a migration with `start_guest` or `stop_guest` to "restore"
a guest — the state you found it in is the state it is left in.

On PVE versions without the native LXC migrate endpoint, `migrate_guest` falls
back to a clone: the source container is **stopped first**, cloned to the target
under a new VMID, and the clone is started there **only if the original was
running**. The stopped original is deliberately **left in place** — this server
never deletes a guest — so verify the copy and remove the original yourself. Both the new VMID and the retained
original are named in the tool's output.

## Development

```bash
npm install
npm run dev            # run with tsx (no build step)
npm run build          # compile TypeScript
npm start              # run compiled output
npm test               # vitest, single run
npm run test:coverage  # vitest with coverage
```

Coverage is enforced at **100%** for statements, branches, functions and lines
(`src/index.ts` excluded); `npm run test:coverage` fails below that.

Test discovery excludes `.claude/`, since git worktrees created there would
otherwise have their copy of every suite collected alongside the real one.