# Proxmox MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io/) server for managing [Proxmox VE](https://www.proxmox.com/) clusters. Talks to the Proxmox VE REST API over HTTPS using a scoped API token. No SSH access to the hypervisor is needed.

## Architecture

```
Claude / Cline (MCP Client)
    ↕ HTTP (Streamable HTTP transport)
Proxmox MCP Server (Docker container)
    ↕ HTTPS :8006 (API token: mcp@pve!mcp)
Proxmox VE REST API (/api2/json)
```

## Prerequisites

- Proxmox VE 8.x or later (tested on 9.2)
- A Proxmox API token for a dedicated user (see step 1)
- Docker + Docker Compose (v2.24+, for the optional `env_file` entry)

## Setup

### 1. Proxmox: user, role and API token

Run these once, as root, in a shell on **any one** cluster node. Users, roles
and ACLs live in `/etc/pve`, so they apply to the whole cluster.

```bash
# Role with exactly what the tools need. Built up in short lines so a wrapped
# paste can't split a privilege name in two.
P="Sys.Audit,VM.Audit,VM.PowerMgmt,VM.Snapshot"
P="$P,VM.Clone,VM.Migrate,VM.Allocate"
P="$P,VM.Config.CPU,VM.Config.Memory,VM.Config.Disk"
P="$P,VM.Config.Network,VM.Config.Options"
P="$P,VM.Config.CDROM,VM.Config.HWType"
P="$P,Datastore.Audit,Datastore.AllocateSpace,SDN.Use"
P="$P,VM.GuestAgent.Audit"
pveum role add MCPOperator -privs "$P"

# Dedicated user in the Proxmox realm (no Linux account, no shell)
pveum user add mcp@pve --comment "Proxmox MCP server"

# Grant the role cluster-wide
pveum acl modify / --users mcp@pve --roles MCPOperator

# Check the result
pveum user permissions mcp@pve --path /
```

The token itself is created in step 3, from the MCP host, so its secret goes
straight into `.env.local` without being copied by hand.

| Privilege | Used by |
|-----------|---------|
| `Sys.Audit`, `VM.Audit`, `Datastore.Audit` | inspection tools, reading ISOs/templates, other users' tasks |
| `VM.PowerMgmt` | start / stop / shutdown / reboot |
| `VM.Snapshot` | snapshots |
| `VM.Allocate`, `VM.Config.*`, `Datastore.AllocateSpace`, `SDN.Use` | `create_vm`, `create_container` (disks on storage, NIC on `vmbr0`) |
| `VM.Clone` | `clone_guest` |
| `VM.Migrate` | `migrate_guest`, `drain_node` |
| `VM.GuestAgent.Audit` | `get_guest_filesystems` on QEMU VMs (PVE 9; on PVE 8 use `VM.Monitor`) |

If a tool fails with `HTTP 403: Permission check failed (/path, Priv.Name)`,
the message names the missing privilege. Add it with
`pveum role modify MCPOperator -append 1 -privs Priv.Name`.

To revoke access, run `pveum user token remove mcp@pve mcp`.

### 2. TLS: trust the cluster CA

Each node's API certificate is signed by the cluster's own CA. On the MCP
host, copy that CA next to the compose file so the certificate can be verified.
Copy it from a node **in the same cluster as `PROXMOX_HOST`**; a CA from any
other Proxmox system makes every request fail with curl status `000`.

```bash
mkdir -p secrets
scp root@10.0.0.22:/etc/pve/pve-root-ca.pem secrets/pve-root-ca.pem
```

`secrets/` is gitignored. If you cannot do this, `PROXMOX_TLS_INSECURE=true`
turns verification off. The server warns at startup when it is set. Don't use
it on a network you don't trust.

### 3. Configure

`.env` holds the non-secret settings and is tracked in git. The app will not
start without `PROXMOX_HOST`, `PROXMOX_TOKEN_ID` and `PROXMOX_TOKEN_SECRET`.

```env
# Any node of the cluster; it proxies requests for the other nodes
PROXMOX_HOST=10.0.0.22
PROXMOX_PORT=8006
PROXMOX_TOKEN_ID=mcp@pve!mcp
# Path to the CA from step 2 (the container always uses /secrets/pve-root-ca.pem)
PROXMOX_CA_CERT=./secrets/pve-root-ca.pem
MCP_PORT=3000

# Default node for tools called without an explicit `node` (default: pve).
PROXMOX_NODE=pve

# Tag that marks a guest as un-migratable (default: dont-move).
# Matched case-insensitively. A blank value falls back to the default rather
# than disabling the protection.
PROXMOX_NO_MIGRATE_TAG=dont-move
```

Secrets go in **`.env.local`**, which is gitignored. Never put them in `.env`.
Both `npm run dev`/`start` and `docker compose` read it.

On the MCP host, create the API token on the node and write its secret and an
MCP auth token into `.env.local` in one go. This needs root SSH to the node one
last time, and re-running it replaces the token:

```bash
set +H   # the token id contains '!', which bash would otherwise try to expand
SECRET=$(ssh root@10.0.0.22 "pveum user token remove mcp@pve mcp 2>/dev/null; pveum user token add mcp@pve mcp --privsep 0 --output-format json" \
  | perl -MJSON::PP -0ne 'print decode_json($_)->{value}')
echo "length: ${#SECRET}"   # expect 36
printf 'PROXMOX_TOKEN_SECRET=%s\nMCP_AUTH_TOKEN=%s\n' "$SECRET" "$(openssl rand -hex 32)" > .env.local
chmod 600 .env.local
```

To rotate only the Proxmox token later, keep the existing `MCP_AUTH_TOKEN`:
run the `SECRET=` line again, then
`sed -i "s/^PROXMOX_TOKEN_SECRET=.*/PROXMOX_TOKEN_SECRET=$SECRET/" .env.local`.

Check the token before starting the server. It should print `200`:

```bash
curl -s -o /dev/null -w '%{http_code}\n' --cacert secrets/pve-root-ca.pem \
  -H "Authorization: PVEAPIToken=mcp@pve!mcp=$SECRET" \
  https://10.0.0.22:8006/api2/json/nodes
```

| Result | Cause |
|--------|-------|
| `200` | Token and certificate are good |
| `401` | Secret doesn't match the current token, or `PROXMOX_HOST` is not in the cluster the token was made in |
| `000` | Connection or TLS failure; usually `pve-root-ca.pem` came from a different system |
| `bash: !mcp: event not found` | Run `set +H` first, or single-quote the header |

#### Migrating from the SSH version

Earlier versions logged in as `root` over SSH and ran `pvesh`. After the API
version is working, remove the MCP host's public key from
`/root/.ssh/authorized_keys` on the Proxmox node.

**Delete only that one line.** On a cluster this file is a symlink to
`/etc/pve/priv/authorized_keys` and also holds the keys the nodes use to reach
each other. Removing those breaks migration and replication. Find the line by
the key's comment (e.g. `you@your-mac`) or its fingerprint
(`ssh-keygen -lf ~/.ssh/id_rsa.pub`).

The old `PROXMOX_SSH_HOST` / `PROXMOX_SSH_USER` / `PROXMOX_SSH_KEY` variables
are no longer read.

`MCP_PORT` is the **host** port; the container always listens on 3000 internally.

#### Updating a host with local .env changes

`.env` is **tracked in git**, so each host that customises it (a different
`PROXMOX_HOST`, say) carries a permanent local modification. When a commit
changes `.env`, `git pull` on that host refuses rather than clobber it:

```
error: Your local changes to the following files would be overwritten by merge: .env
Please commit your changes or stash them before you merge. Aborting
```

Stash the host's own values, pull, then put them back:

```bash
git stash push -m "host env" .env
git pull
git stash pop
```

Git merges the two sets of changes, so the host keeps its own values and gains
whatever the commit added. Confirm with `grep PROXMOX_ .env`. If a future change
edits a line a host has customised, `git stash pop` reports a conflict in
`.env` — resolve it keeping the host's values, then `git stash drop`.

`git status` will keep showing `.env` as modified on that host. That is the
steady state, and the trade-off of keeping `.env` in version control.

### 4. Authentication

`/mcp` is protected by a shared-secret Bearer token. Set `MCP_AUTH_TOKEN` in
`.env.local` (step 3 does this) and every request must carry `Authorization: Bearer <token>`; anything else gets a
401.

**If `MCP_AUTH_TOKEN` is unset the endpoint is completely unauthenticated** —
anyone who can reach the port can create and destroy guests on your cluster. The
server logs a warning at startup when this is the case. It is left optional so
local development stays frictionless, but do not run it this way on a network
you do not trust.

`/health` is deliberately left open so orchestrators can probe it without
credentials.

### 5. Run

```bash
docker compose up -d --build
```

After changing `.env` or `.env.local`, run `docker compose up -d --force-recreate`
so the container picks up the new values.

Verify:

```bash
curl http://localhost:3000/health
# {"status":"ok","service":"proxmox-mcp"}

# Real API call through the server's own client; lists every node
docker compose exec proxmox-mcp node --input-type=module -e '
const p = await import("/app/dist/proxmox.js");
console.log((await p.pvesh("get", "/nodes")).map(n => `${n.node}: ${n.status}`).join("\n"));'
```

`/health` does not touch Proxmox, so a green health check alone does not prove
the token works.

### 6. Connect MCP Client

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
| `get_guest_filesystems` | Filesystem usage inside a running guest: every mount for QEMU VMs (needs `qemu-guest-agent` in the guest and `agent=1`), root filesystem for LXC |
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