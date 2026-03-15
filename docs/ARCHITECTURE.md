# NanoClaw Architecture

A single Node.js process that routes messages from chat platforms to Claude agents running in isolated Docker containers. Each agent gets its own filesystem, session memory, and tool set. The host never exposes real API credentials to containers.

This document maps the system as it exists today, then identifies where the architecture can evolve for scientific research workflows.

---

## System Overview

```
┌──────────────────────────────────────────────────────────┐
│  Host (macOS / Linux)                                    │
│                                                          │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │  Discord     │  │  Telegram    │  │  (other)       │  │
│  │  Channel     │  │  Channel     │  │  Channels      │  │
│  └──────┬───────┘  └──────┬───────┘  └───────┬────────┘  │
│         │                 │                   │           │
│         └─────────┬───────┘───────────────────┘           │
│                   ▼                                       │
│  ┌────────────────────────────────────────────────────┐   │
│  │  Orchestrator  (src/index.ts)                      │   │
│  │  - Message polling loop (2s interval)              │   │
│  │  - Per-group cursor tracking                       │   │
│  │  - Session command interception (/compact, /model) │   │
│  │  - Trigger pattern enforcement                     │   │
│  └───────────┬────────────────────────────────────────┘   │
│              │                                            │
│  ┌───────────▼────────────────────────────────────────┐   │
│  │  GroupQueue  (src/group-queue.ts)                   │   │
│  │  - Concurrency limiter (MAX_CONCURRENT_CONTAINERS) │   │
│  │  - Per-group state: active, idle, pending           │   │
│  │  - Tasks prioritized over messages                 │   │
│  │  - Follow-up message piping via IPC                │   │
│  └───────────┬────────────────────────────────────────┘   │
│              │                                            │
│  ┌───────────▼──────────┐  ┌──────────────────────────┐   │
│  │  Container Runner     │  │  Credential Proxy        │   │
│  │  (container-runner.ts)│  │  (credential-proxy.ts)   │   │
│  │  - Builds mount list  │  │  - HTTP proxy on :3001   │   │
│  │  - Spawns docker run  │  │  - Injects real API key  │   │
│  │  - Parses output      │  │  - Container gets fake   │   │
│  │    markers             │  │    placeholder only      │   │
│  └───────────┬──────────┘  └──────────────────────────┘   │
│              │                                            │
└──────────────┼────────────────────────────────────────────┘
               │
    ┌──────────▼───────────────────────────────────────┐
    │  Docker Container                                │
    │                                                  │
    │  ┌──────────────────────────────────────────┐    │
    │  │  Agent Runner  (agent-runner/src/index.ts)│    │
    │  │  - Reads JSON from stdin                  │    │
    │  │  - Calls Claude Agent SDK query()         │    │
    │  │  - MessageStream for follow-up messages   │    │
    │  │  - IPC polling (/workspace/ipc/input/)    │    │
    │  │  - Output via sentinel markers to stdout  │    │
    │  └──────────────────────────────────────────┘    │
    │                                                  │
    │  Mounts:                                         │
    │  /workspace/group     ← groups/{folder}/  (RW)   │
    │  /workspace/global    ← groups/global/    (RO)   │
    │  /workspace/extra/*   ← additional mounts        │
    │  /workspace/ipc/      ← IPC namespace     (RW)   │
    │  /home/node/.claude/  ← sessions + skills (RW)   │
    │                                                  │
    │  Tools:                                          │
    │  claude-code, agent-browser, pdf-reader,         │
    │  biorxiv, python3, bash, curl, jq, git           │
    │                                                  │
    │  MCP Server:                                     │
    │  nanoclaw (send_message, schedule_task, etc.)     │
    └──────────────────────────────────────────────────┘
```

---

## Data Flow: Message → Response

```
1. User sends "analyze this dataset" in Discord #blood-vessel-hypoxia

2. DiscordChannel.onMessage()
   → Translates @bot mention to @Mercury trigger
   → Calls storeMessage() → SQLite messages table
   → Calls onChatMetadata() → SQLite chats table

3. startMessageLoop() polls every 2000ms
   → getNewMessages() returns unprocessed messages per group
   → Groups with new messages get processGroupMessages() calls

4. processGroupMessages(chatJid, group)
   → Session command check: is it /compact or /model? → handle without container
   → Trigger check: non-main groups require @Mercury prefix
   → Cursor advanced immediately (crash-safe)
   → formatMessages() → XML envelope with sender, timestamp, content

5. runContainerAgent(group, xmlPrompt, chatJid, onOutput)
   → buildVolumeMounts(): project dir, group folder, IPC, sessions
   → Write settings.json with model preference and env flags
   → Sync skills from container/skills/ → group's .claude/skills/
   → docker run -i --rm with mounted volumes
   → stdin: JSON {prompt, sessionId, groupFolder, chatJid, isMain}

6. Agent Runner (inside container)
   → Reads stdin JSON
   → query() with prompt as MessageStream (allows follow-up piping)
   → Claude SDK runs: reads CLAUDE.md, uses tools (Bash, Read, Write, etc.)
   → Results emitted via ---NANOCLAW_OUTPUT_START--- markers

7. Container Runner (host side)
   → Parses output markers from container stdout
   → Strips <internal>...</internal> blocks from response
   → Calls channel.sendMessage(chatJid, cleanedText)
   → User sees response in Discord
```

---

## Core Subsystems

### Orchestrator (`src/index.ts`)

The central event loop. Maintains three pieces of persistent state:

| State | Scope | Purpose |
|-------|-------|---------|
| `lastTimestamp` | Global | High-water mark for all new messages |
| `lastAgentTimestamp` | Per-group | Cursor: what the agent has "seen" |
| `sessions` | Per-group | Claude SDK session ID for continuity |

**Key design choice**: the cursor advances *before* the agent runs, not after. If the process crashes mid-run, messages aren't re-processed on restart. If the agent fails *after* producing output, the cursor stays advanced (no duplicate messages to users). If the agent fails *before* producing output, the cursor rolls back so the work is retried.

The orchestrator also intercepts commands before they reach the container:
- `/compact` → handled by `session-commands.ts`, runs compaction in a fresh container
- `/model opus|sonnet|haiku` → updates DB + deletes cached settings.json, no container needed

### Channel System (`src/channels/`)

Self-registering plugin architecture. Each channel file calls `registerChannel(name, factory)` at module load time. The factory receives callbacks and returns a `Channel` interface or `null` (if credentials are missing).

```
src/channels/index.ts          ← barrel file, imports all channels
src/channels/registry.ts       ← registerChannel() + getChannels()
src/channels/discord.ts        ← Discord implementation
src/channels/telegram.ts       ← Telegram implementation
```

Channels are responsible for:
- Translating platform-specific message formats into `NewMessage`
- Translating platform mentions into the trigger pattern (`@AssistantName`)
- Storing chat metadata for group discovery
- Routing outbound messages (message splitting for platform limits)

**JID format**: Each platform gets a prefix — `dc:123` (Discord), `tg:456` (Telegram), `wa:789@g.us` (WhatsApp). The orchestrator doesn't care about the format; it passes JIDs opaquely to whichever channel claims `ownsJid(jid)`.

### Container Runner (`src/container-runner.ts`)

Transforms a `(group, prompt)` pair into a running Docker container with the right mounts, environment, and input.

**Mount construction** is the most security-critical logic:
- Main group: gets project root (read-only) + own folder (read-write)
- Non-main groups: only own folder + global CLAUDE.md (read-only)
- Additional mounts validated against `~/.config/nanoclaw/mount-allowlist.json`
- Mount allowlist is *outside* the project — agents can't modify it
- `nonMainReadOnly` flag forces all non-main mounts to read-only

**Per-group session directory** at `data/sessions/{folder}/.claude/`:
- `settings.json` — model preference, env flags (agent teams, auto-memory, etc.)
- `skills/` — copied from `container/skills/` on each container start
- Session transcripts and index managed by Claude SDK

**Settings.json lifecycle**:
- Created on first run with default env and model from `containerConfig`
- On subsequent runs, only the `model` field is updated (preserving agent-applied customizations)
- Deleted by `/model` command to force full recreation

### Agent Runner (`container/agent-runner/src/index.ts`)

Runs *inside* the container. Bridges between NanoClaw's IPC protocol and the Claude Agent SDK.

**Message streaming**: Uses a custom `MessageStream` (async iterable) rather than passing a single string prompt. This keeps `isSingleUserTurn=false` in the SDK, allowing agent teams subagents to complete. It also enables piping follow-up messages into the active query via IPC.

**IPC polling**: Checks `/workspace/ipc/input/` every 500ms for new message files or a `_close` sentinel. Messages are fed into the active `MessageStream`. The `_close` sentinel triggers graceful shutdown.

**Query loop**: After each query completes, the runner waits for the next IPC message and starts a new query (resuming the same session). This keeps the container warm for conversational back-and-forth without respawning.

**Pre-compact hook**: Before the SDK compacts context, the full transcript is archived to `conversations/` as a markdown file. This preserves the raw conversation history.

### Group Queue (`src/group-queue.ts`)

Concurrency controller. Limits active containers to `MAX_CONCURRENT_CONTAINERS` (default: 5). Each group gets a state machine:

```
idle → active (running container)
     → idleWaiting (container alive, waiting for IPC)
     → pendingMessages (queued, waiting for slot)
     → pendingTasks (scheduled tasks queued)
```

**Priority**: Tasks drain before messages. If a group has both a pending task and pending messages, the task runs first.

**Follow-up piping**: When a container is `idleWaiting` and a new message arrives, `sendMessage()` writes it to the group's IPC directory. The agent runner picks it up and feeds it into the active query without spawning a new container.

### Database (`src/db.ts`)

SQLite via better-sqlite3. Seven tables:

| Table | Role |
|-------|------|
| `messages` | Inbound messages for registered groups |
| `chats` | Discovered chats/channels (for group discovery UI) |
| `registered_groups` | Group config: name, folder, trigger, `container_config` JSON |
| `sessions` | Per-group Claude SDK session IDs |
| `router_state` | Global key-value state (cursors) |
| `scheduled_tasks` | Task definitions with schedule and status |
| `task_run_logs` | Execution history per task |

`container_config` is a JSON column on `registered_groups` that holds per-group settings like `model`, `additionalMounts`, and `timeout`. This is where the model router stores its state.

### IPC System (`src/ipc.ts`)

File-based interprocess communication. The container writes JSON files to `/workspace/ipc/{type}/`, and the host polls for them every 1000ms.

**Supported operations** (via nanoclaw MCP server inside container):
- `send_message` — agent sends a message to any (authorized) chat
- `schedule_task`, `list_tasks`, `pause_task`, `resume_task`, `cancel_task`
- `register_group` — register a new chat (main only)
- `refresh_groups` — sync group metadata from channels (main only)

**Authorization model**: The group's identity is determined by its IPC directory path (`data/ipc/{folder}/`), not by any header the container sets. Non-main groups can only send messages to their own JID and manage their own tasks.

### Task Scheduler (`src/task-scheduler.ts`)

Polls `getDueTasks()` every 60 seconds. Due tasks are enqueued to `GroupQueue` for execution. Supports three schedule types:
- **Cron**: Standard cron expressions with timezone
- **Interval**: Millisecond intervals, anchored to last run (prevents drift)
- **Once**: Single execution, auto-marks completed

Tasks run as full agent invocations in the group's context, with the prompt prefixed `[SCHEDULED TASK]`. They get shorter idle timeouts (10s vs 30min) since they're single-turn.

### Skills System (`container/skills/`)

Skill documents are markdown files that Claude reads from `~/.claude/skills/` inside the container. Each skill directory contains:
- `SKILL.md` — instructions, usage examples, best practices
- Optional CLI tool (e.g., `biorxiv`, `pdf-reader`) that gets installed to `/usr/local/bin/`

Skills are synced from `container/skills/` to each group's `data/sessions/{folder}/.claude/skills/` on every container start. This means:
- All groups get all skills
- Updating a skill document takes effect on next container start
- No container rebuild needed for skill doc changes (only for CLI tool changes)

Current skills: `agent-browser`, `biorxiv`, `pdf-reader`, `scvi-tools`

### Security Boundaries

```
┌─────────────────────────────────────────────────┐
│  Host                                           │
│                                                 │
│  ~/.config/nanoclaw/                            │
│  ├── mount-allowlist.json  (controls mounts)    │
│  └── sender-allowlist.json (controls who talks) │
│                                                 │
│  .env (credentials — never enters container)    │
│                                                 │
│  Credential Proxy (injects auth at HTTP level)  │
│                                                 │
│  ┌───────────────────────────────────────────┐  │
│  │  Container (OS-level isolation)           │  │
│  │  - Sees only mounted paths                │  │
│  │  - Has placeholder API key only           │  │
│  │  - IPC directory = identity proof         │  │
│  │  - Non-main: can't see other groups       │  │
│  │  - Non-main: can't write global CLAUDE.md │  │
│  └───────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

Key invariants:
1. **Credentials never enter containers** — the proxy intercepts at the HTTP level
2. **Mount allowlist lives outside the project** — agents can't modify their own permissions
3. **Group identity is structural** — derived from filesystem paths, not self-reported
4. **Non-main groups are sandboxed** — can't see other groups, can't write global memory

---

## Your Current Setup

```
Channels:    Discord (Mercury#7363)
Groups:      discord_main (#general, main, Sonnet)
             blood_vessel_hypoxia (#blood-vessel-hypoxia, Sonnet)
Mount:       /Users/aolhava/Desktop/Berkeley/2026 Spring/blood_vessel_hypoxia
             → /workspace/extra/blood_vessel_hypoxia (read-write)
Container:   2.83GB (Node 22, Chromium, Python3, pdf-reader, biorxiv, jq)
Skills:      agent-browser, biorxiv, pdf-reader, scvi-tools
```

---

## Opportunities for a Research Agent

The sections below identify specific architectural leverage points — places where the existing design either already supports research workflows or could be extended with targeted changes.

### 1. Persistent Research Context

**What exists**: Each group has a `CLAUDE.md` that the agent reads on every invocation, plus auto-memory (Claude SDK writes `~/.claude/` memories). Conversation transcripts are archived to `conversations/` on `/compact`.

**The gap**: There's no structured knowledge base that accumulates across sessions. The agent starts each conversation with CLAUDE.md + whatever auto-memory the SDK saved, but there's no deliberate mechanism for building up domain knowledge — hypotheses tested, results obtained, papers read, dead ends explored.

**Where to extend**:
- **`groups/{folder}/CLAUDE.md`** is already the natural place for persistent research context. But it's currently write-once (you or the agent edits it manually). A research workflow would benefit from the agent *automatically* appending structured findings after each session — a "lab notebook" section at the bottom of CLAUDE.md that grows over time.
- **`conversations/` archive** (written by the PreCompact hook in `container/agent-runner/src/index.ts:145-185`) already preserves full transcripts as markdown. These could be post-processed into structured summaries. Right now they're just stored; nothing reads them back.
- **A research memory skill** could maintain a structured file (e.g., `groups/{folder}/research-state.json` or `research-log.md`) that the agent updates at the end of each session. The group CLAUDE.md would instruct the agent to read this file at session start and update it at session end. No code changes needed — just a convention enforced by CLAUDE.md instructions.

### 2. Multi-Session Experimental Workflows

**What exists**: The task scheduler can run agents on cron schedules or one-time triggers. Tasks execute in the group's context with full tool access.

**The gap**: There's no concept of a multi-step experimental pipeline. You can schedule a task to run daily, but you can't express "run step A, then when it finishes, run step B with A's results, then notify me."

**Where to extend**:
- **`src/task-scheduler.ts`** currently supports `cron`, `interval`, and `once` schedule types. A `pipeline` type could chain tasks: each step's output becomes the next step's input, with the pipeline stored as a JSON definition in the group folder.
- **IPC `schedule_task`** already accepts arbitrary prompts. A pipeline could be a sequence of prompts with conditional logic: "If step 2 found differentially expressed genes, run step 3 with those genes; otherwise, adjust parameters and retry step 2."
- **Lower-hanging fruit**: The agent can already `schedule_task` from within a session. You could instruct the agent (via CLAUDE.md) to schedule follow-up tasks before ending a session — a manual pipeline using the existing mechanism.

### 3. Model Routing for Cost vs. Capability

**What exists**: Per-group model selection via `containerConfig.model`. The `/model` command and `scripts/toggle-bvh-model.sh` switch between Opus, Sonnet, and Haiku.

**The gap**: Model selection is per-group and manual. There's no way to say "use Opus for hypothesis generation but Sonnet for data cleaning" within a single group, or to automatically escalate to Opus when the agent encounters something it can't handle.

**Where to extend**:
- **`settings.json`** (written by `container-runner.ts:125-152`) controls the model. Today it's set once per container invocation. The agent *inside* the container could modify its own `settings.json` mid-session, but the SDK reads it at startup.
- **Prompt-level routing**: The orchestrator could inspect the incoming message content (before passing to the container) and select a model based on keywords or classification. This would happen in `processGroupMessages()` around line 200 in `index.ts`, right where `/model` is currently handled.
- **Agent-initiated escalation**: The agent could use the `send_message` MCP tool to send itself a `/model opus` command, then `/compact` to restart on the new model. Hacky but works today with no code changes.
- **The real fix**: Add a `modelRouter` function to `container-runner.ts` that takes the prompt and group config, returns a model. Default implementation: return `containerConfig.model`. Research implementation: classify the prompt (hypothesis vs. data work vs. literature review) and pick accordingly.

### 4. Cross-Group Knowledge Sharing

**What exists**: Groups are strictly isolated. The only shared context is `groups/global/CLAUDE.md` (read-only for non-main groups).

**The gap**: Research projects don't exist in isolation. Your blood vessel hypoxia work might benefit from findings in a future cardiology group, or from a methods group that develops reusable analysis pipelines.

**Where to extend**:
- **`groups/global/CLAUDE.md`** is already mounted into every container. It could serve as a shared "research registry" — a table of active projects, key findings, and cross-references. The main group agent could maintain this.
- **Additional mounts**: `containerConfig.additionalMounts` already supports mounting arbitrary directories. A "shared results" directory mounted into multiple groups would allow cross-pollination. The mount allowlist already supports this — just add the shared directory to `allowedRoots`.
- **A synthesis agent**: Register a dedicated group whose CLAUDE.md instructs it to read all other groups' research states and produce cross-project insights. Schedule it weekly. It reads from shared mounts, writes a synthesis to its own folder, and the global CLAUDE.md references the synthesis.

### 5. Tool Ecosystem

**What exists**: Container agents have Bash, web search, browser automation, PDF reading, bioRxiv search, and Python3 (for scvi-tools, scanpy, etc.).

**Where to extend for research**:
- **CLI tools** (like `biorxiv` and `pdf-reader`) are the easiest to add. They're bash scripts installed to `/usr/local/bin/` in the Dockerfile. Adding PubMed, UniProt, GEO, or BLAST follows the same pattern: write a bash script, add a SKILL.md, add a COPY+chmod to the Dockerfile.
- **Python packages**: The container now has Python3 and venv support. The pattern is: SKILL.md tells the agent to create a venv in the project workspace on first use. Packages persist across sessions because the project directory is mounted read-write. This is better than pre-installing heavy packages in the Dockerfile (which would balloon image size).
- **MCP servers**: The agent runner already configures the `nanoclaw` MCP server (`agent-runner/src/index.ts:416-426`). Additional MCP servers could be added here — either hardcoded in the agent runner, or dynamically configured via `settings.json`. The SDK supports arbitrary MCP servers via the `mcpServers` option.
- **R / Bioconductor**: Many biology papers use R. Adding R to the container would follow the same pattern as Python — install `r-base` in the Dockerfile, create SKILL.md for Seurat/DESeq2/etc. The trade-off is container size (R + Bioconductor adds ~2GB).

### 6. Conversation Continuity and Context Quality

**What exists**: Sessions persist via Claude SDK session IDs. The `/compact` command manually triggers context compaction. Auto-memory saves preferences between sessions.

**The gap**: Long research sessions degrade as context fills up. The agent forgets earlier analysis, repeats itself, or loses track of the experimental plan. `/compact` helps but is manual, and the compaction summary may lose important details.

**Where to extend**:
- **Structured session summaries**: The PreCompact hook (`agent-runner/src/index.ts:145-185`) could write a structured summary (hypotheses, findings, next steps) instead of raw transcript markdown. The CLAUDE.md could instruct the agent to produce this summary before each `/compact`.
- **Automatic compaction triggers**: The orchestrator could track context usage (the SDK may expose token counts) and send `/compact` automatically at a threshold. This would be a small addition to `startMessageLoop()`.
- **Session handoff prompts**: When compacting, the CLAUDE.md could instruct the agent to write a "handoff document" to the group folder — a structured file that the next session reads on startup. This is more reliable than relying on the SDK's automatic summary.
- **Experiment state files**: Instead of keeping everything in conversation context, instruct the agent to write intermediate results to files in the group folder. The context then just needs to know "the latest differential expression results are in `results/de_hypoxia_vs_normoxia.csv`" rather than holding all the data in memory.

### 7. Human-in-the-Loop Workflows

**What exists**: The agent runs autonomously once triggered. You see results in Discord. You can send follow-up messages that pipe into the active container.

**The gap**: Research requires judgment calls. "Should I use this batch correction method or that one?" "Is this cluster real or an artifact?" The agent currently either makes the call itself or asks in chat and waits for a response (which may come after the container times out).

**Where to extend**:
- **Approval gates**: The nanoclaw MCP server (`agent-runner/src/ipc-mcp-stdio.ts`) could gain a `request_approval` tool that sends a question to the user and blocks until they respond. The orchestrator would write the response to the IPC input directory. This turns the agent into a "propose and wait" system.
- **Checkpoint-and-resume**: The agent could save its state to a file, send a summary to Discord, then exit. When you respond, the next session reads the checkpoint and continues. This is implementable today via CLAUDE.md conventions — tell the agent to write `checkpoint.json` with its plan and progress, and read it on session start.
- **Interactive notebooks**: Rather than doing everything in chat, the agent could create/modify Jupyter notebooks in the mounted project directory. You review the notebook, make edits, then tell the agent to continue. The notebook serves as both the working document and the communication channel.

### 8. Observability for Research

**What exists**: Container logs at `groups/{folder}/logs/container-*.log`. Service log at `logs/nanoclaw.log`. Task run logs in the database.

**Where to extend**:
- **Experiment tracking**: The agent could log structured experiment metadata (parameters, metrics, timestamps) to a file or database. This is different from conversation logs — it's about what was *done*, not what was *said*.
- **Cost tracking**: The credential proxy (`src/credential-proxy.ts`) sees every API call. It could log token usage per group, per model, per session. This would let you answer "how much did that Opus analysis cost?" Research budgets are real.
- **Result provenance**: When the agent produces a finding, trace it back to which data, which code, and which conversation produced it. The conversation archive + git history of the project directory together provide this, but it's not surfaced in a usable way.

---

## File Map

```
nanoclaw/
├── src/
│   ├── index.ts               # Orchestrator: message loop, state, agent dispatch
│   ├── channels/
│   │   ├── registry.ts         # Channel self-registration system
│   │   ├── index.ts            # Barrel file (imports trigger registration)
│   │   ├── discord.ts          # Discord channel implementation
│   │   └── telegram.ts         # Telegram channel implementation
│   ├── container-runner.ts     # Container spawning, mounts, output parsing
│   ├── container-runtime.ts    # Docker runtime abstraction
│   ├── credential-proxy.ts     # HTTP proxy that injects real API credentials
│   ├── group-queue.ts          # Concurrency control, follow-up message piping
│   ├── ipc.ts                  # File-based IPC watcher + task operations
│   ├── session-commands.ts     # /compact interception and execution
│   ├── task-scheduler.ts       # Cron/interval/once task execution
│   ├── db.ts                   # SQLite schema + all queries
│   ├── router.ts               # Message XML formatting + outbound cleaning
│   ├── config.ts               # Environment + path configuration
│   ├── env.ts                  # .env file reader
│   ├── mount-security.ts       # Mount allowlist validation
│   ├── sender-allowlist.ts     # Sender filtering (trigger/drop modes)
│   ├── ipc-auth.ts             # IPC authorization checks
│   ├── group-folder.ts         # Folder name validation + path resolution
│   ├── remote-control.ts       # Claude Code remote control sessions
│   ├── logger.ts               # Pino logger setup
│   └── types.ts                # Shared interfaces
├── container/
│   ├── Dockerfile              # Agent container image definition
│   ├── build.sh                # Container build script
│   ├── agent-runner/
│   │   └── src/
│   │       ├── index.ts        # Agent entry point (stdin → SDK → stdout)
│   │       └── ipc-mcp-stdio.ts# Nanoclaw MCP server (IPC tools)
│   └── skills/
│       ├── agent-browser/      # Web browsing tool docs
│       ├── biorxiv/            # bioRxiv search CLI + docs
│       ├── pdf-reader/         # PDF text extraction CLI + docs
│       └── scvi-tools/         # Single-cell analysis docs
├── groups/
│   ├── global/CLAUDE.md        # Shared across all groups (read-only)
│   ├── discord_main/           # Main group workspace
│   └── blood_vessel_hypoxia/   # Project group workspace
│       └── CLAUDE.md           # Project-specific agent instructions
├── data/
│   ├── sessions/{folder}/.claude/  # Per-group sessions, settings, skills
│   ├── ipc/{folder}/               # Per-group IPC directories
│   └── env/env                     # Container environment copy
├── store/
│   ├── messages.db             # SQLite database
│   └── auth/                   # Channel authentication state
├── docs/
│   ├── REQUIREMENTS.md         # Design philosophy and decisions
│   └── ARCHITECTURE.md         # This file
├── scripts/
│   └── toggle-bvh-model.sh    # Quick Opus↔Sonnet toggle for blood_vessel_hypoxia
├── .env                        # Credentials (never enters containers)
└── ~/.config/nanoclaw/
    ├── mount-allowlist.json    # Controls what directories agents can access
    └── sender-allowlist.json   # Controls who can talk to the agent
```

---

## Design Principles That Matter for Research

1. **Customization = code changes**. There are no config files to express "use Opus for hypothesis generation." You'd add a `modelRouter` function. This is intentional — the codebase is small enough that code changes are safe, and they're more expressive than any config format.

2. **Skills over features**. New capabilities are added as skill branches (`git merge upstream/skill/compact`) rather than built-in features. This keeps the core small. For research, this means each lab's NanoClaw can have different tools without carrying everyone's dependencies.

3. **Security through isolation, not permissions**. The container boundary is the security model. Agents can't escape their mounts. This means you can safely give an agent `Bash` access, `pip install` privileges, and read-write access to research data — because it's all scoped to the container.

4. **File-based everything**. Memory is CLAUDE.md files. IPC is JSON files. Transcripts are markdown files. This makes the system inspectable, debuggable, and version-controllable. For research, it means you can `git diff` the agent's accumulated knowledge, review what it wrote, and correct it.
