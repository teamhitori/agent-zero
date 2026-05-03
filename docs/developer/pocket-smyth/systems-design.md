# Agent Zero — Systems Design Analysis

> **Purpose:** Architectural evaluation for Pocket Smyth adoption/integration decisions.  
> **Source:** `upstream/development` @ `d357c24d` (April 2026)  
> **Author:** Generated from static code analysis  

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Architecture Overview](#2-architecture-overview)
3. [The Core Agentic Loop — Deep Dive](#3-the-core-agentic-loop--deep-dive)
4. [Hierarchical Agent Delegation](#4-hierarchical-agent-delegation)
5. [Memory Subsystem](#5-memory-subsystem)
6. [Extension System](#6-extension-system)
7. [MCP Integration (Server + Client)](#7-mcp-integration-server--client)
8. [A2A (Agent-to-Agent) Protocol](#8-a2a-agent-to-agent-protocol)
9. [Tool System — Brief Overview](#9-tool-system--brief-overview)
10. [Configuration & Settings — Brief Overview](#10-configuration--settings--brief-overview)
11. [Prompt Template System — Brief Overview](#11-prompt-template-system--brief-overview)
12. [Docker/RFC Execution — Brief Overview](#12-dockerrfc-execution--brief-overview)
13. [Architectural Trade-offs & Limitations](#13-architectural-trade-offs--limitations)

---

## 1. Executive Summary

Agent Zero is a monologue-loop agentic framework where a single LLM runs in a
tight think-act-observe cycle until it explicitly returns a `response` tool call.
It supports hierarchical delegation (agents spawning sub-agents), persistent
vector memory (FAISS), an extension system that makes nearly every function
hookable, and native MCP + A2A protocol support. The entire stack runs as a
single ASGI process multiplexing Flask REST, WebSocket (Socket.IO), MCP, and A2A
under one port via Starlette routing.

### Core Files

| File | Role |
|------|------|
| `agent.py` | AgentContext, Agent, LoopData, monologue loop, tool dispatch |
| `helpers/extension.py` | Extension point system + `@extensible` decorator |
| `helpers/history.py` | Conversation history: Message, Topic, Bulk, History, compression |
| `helpers/subagents.py` | Agent profile resolution, file path hierarchy |
| `helpers/mcp_handler.py` | MCP client — connects to external MCP servers |
| `helpers/mcp_server.py` | MCP server — exposes A0 as an MCP tool provider |
| `tools/call_subordinate.py` | Hierarchical sub-agent delegation |
| `tools/response.py` | Loop termination — returns final answer |
| `plugins/_memory/` | Full memory plugin (FAISS, recall, memorize, knowledge) |
| `run_ui.py` | ASGI app assembly: Flask + Socket.IO + MCP + A2A |

---

## 2. Architecture Overview

```
+-------------------------------------------------------------------+
|                         ASGI Process (Uvicorn)                    |
|                                                                   |
|  socketio.ASGIApp  (outermost — intercepts WebSocket)             |
|    |                                                              |
|    +-- Starlette Router                                           |
|          |                                                        |
|          +-- /mcp   --> DynamicMcpProxy (SSE + Streamable HTTP)   |
|          |                                                        |
|          +-- /a2a   --> DynamicA2AProxy (FastA2A)                 |
|          |                                                        |
|          +-- /      --> WSGIMiddleware(Flask)                     |
|                          |                                        |
|                          +-- REST API  (/api/*)                   |
|                          +-- Static WebUI                         |
+-------------------------------------------------------------------+
         |                    |                     |
    WebSocket             HTTP REST            MCP/A2A Clients
    (live UI)           (chat, settings)       (external agents)
```

### Process Model

- **Single Python process**, single ASGI server (Uvicorn)
- **No worker pool** — async I/O via `asyncio`, CPU-bound work runs in threads via `DeferredTask`
- **State lives in-process** — `AgentContext._contexts` dict, `Memory.index` dict, `MCPConfig` singleton
- **Persistence** — chat history serialized to JSON files, vector DB saved to disk (FAISS `save_local`)

---

## 3. The Core Agentic Loop — Deep Dive

The loop lives in `Agent.monologue()` (~200 lines in `agent.py`). This is the
heartbeat of the entire system.

### 3.1 Call Chain

```
User sends message
       |
       v
AgentContext.communicate(UserMessage)
       |
       +-- If task running: set intervention on current agent chain
       +-- If idle: start new DeferredTask
       |
       v
AgentContext._process_chain(agent, msg)
       |
       +-- hist_add_user_message(msg)     <-- adds to history
       +-- agent.monologue()              <-- ENTERS THE LOOP
       |       |
       |       +-- [returns final response string]
       |
       +-- if agent has superior:
       |       _process_chain(superior, response)   <-- recursive unwind
       |
       +-- extension: "process_chain_end"
       v
Task completes
```

### 3.2 Monologue Loop — Iteration Detail

```
monologue():
  |
  +-- LoopData initialized
  +-- EXT: "monologue_start"            (memory init, chat rename...)
  |
  +-- OUTER LOOP (restarts on recoverable errors):
  |     |
  |     +-- INNER LOOP (message loop — runs until response tool):
  |     |     |
  |     |     +-- iteration++
  |     |     +-- EXT: "message_loop_start"     (iteration counter)
  |     |     +-- handle_intervention()         (check for user interrupt)
  |     |     |
  |     |     +-- prepare_prompt():
  |     |     |     +-- EXT: "message_loop_prompts_before"
  |     |     |     +-- get_system_prompt()
  |     |     |     |     +-- EXT: "system_prompt"     (main, tools, MCP,
  |     |     |     |     |                             secrets, skills,
  |     |     |     |     |                             project, behaviour,
  |     |     |     |     |                             memory recall...)
  |     |     |     +-- history.output()
  |     |     |     +-- EXT: "message_loop_prompts_after"  (memory recall wait)
  |     |     |     +-- assemble [SystemMessage, ...history]
  |     |     |
  |     |     +-- EXT: "before_main_llm_call"
  |     |     +-- call_chat_model(prompt)       --> LLM inference
  |     |     |     |
  |     |     |     +-- streaming callbacks:
  |     |     |           reasoning_callback()  --> EXT: "reasoning_stream_chunk"
  |     |     |           stream_callback()     --> EXT: "response_stream_chunk"
  |     |     |
  |     |     +-- EXT: "reasoning_stream_end"
  |     |     +-- EXT: "response_stream_end"
  |     |     |
  |     |     +-- if response == last_response:
  |     |     |     +-- hist_add_warning("repeat")   <-- anti-stuck mechanism
  |     |     |
  |     |     +-- else:
  |     |     |     +-- hist_add_ai_response(response)
  |     |     |     +-- process_tools(response)
  |     |     |           |
  |     |     |           +-- parse JSON tool request from LLM output
  |     |     |           +-- resolve tool (MCP first, then local)
  |     |     |           +-- EXT: "tool_execute_before"
  |     |     |           +-- tool.execute(**args)
  |     |     |           +-- EXT: "tool_execute_after"
  |     |     |           +-- if response.break_loop:
  |     |     |           |     return response.message   <-- EXIT LOOP
  |     |     |           +-- else: add tool result to history, continue
  |     |     |
  |     |     +-- EXT: "message_loop_end"   (compress history, save chat)
  |     |     |
  |     |     +-- [loop back to INNER LOOP]
  |     |
  |     +-- on exception:
  |           +-- handle_exception()
  |           +-- EXT: _functions/agent/Agent/handle_exception/end/
  |           |     _40: InterventionException -> continue loop
  |           |     _50: RepairableException -> warn + continue
  |           |     _90: CriticalException -> log + kill
  |           +-- [OUTER LOOP restarts on recoverable]
  |
  +-- EXT: "monologue_end"    (memorize fragments, memorize solutions,
  |                            waiting-for-input UI message)
  v
returns final response string
```

### 3.3 Key Design Decisions

**Loop termination is tool-driven.** The LLM must output a `response` tool call
with `break_loop=True` to exit. There is no iteration limit in the core — the
loop runs indefinitely until the agent decides it's done. The only forced exits
are critical exceptions.

**Every LLM output is expected to be a JSON tool call.** If the output doesn't
parse as valid JSON with `tool_name` + `tool_args`, a "misformat" warning is
injected into history and the loop continues. This means the agent is always
expected to think in tool calls, not free-form text.

**History compression happens inline.** At the end of every message loop
iteration, a background task compresses conversation history if it exceeds the
context window budget. This is transparent to the loop.

**Interventions are cooperative.** When a user sends a new message while the
agent is running, `agent.intervention` is set. The loop checks
`handle_intervention()` at multiple points. If an intervention exists, the
current LLM progress is saved and the new message is injected, then an
`InterventionException` restarts the inner loop.

### 3.4 Core Classes

**`AgentContext`** — A session. Owns one root `Agent` (agent0), a `Log`, a
`DeferredTask`, and a data dict. All contexts are tracked in a class-level dict
`_contexts`. Each context has an `id`, a `type` (USER, TASK, BACKGROUND), and
manages the communicate/run lifecycle. Contexts are thread-safe via `_contexts_lock`.

**`Agent`** — A reasoning actor. Has a `number` (0 = root, 1+ = subordinates), a
`config` (AgentConfig), a `history` (History), and a free `data` dict. The agent
is stateful — it accumulates conversation history across iterations. Multiple
Agent instances can exist in a chain (superior ↔ subordinate).

**`LoopData`** — Per-monologue mutable state bag. Holds iteration count, system
prompt list, history output, extras (persistent and temporary), params, and
current tool reference. Extensions read and write this freely.

**`AgentConfig`** — Minimal config: `mcp_servers` JSON string, `profile` name,
`knowledge_subdirs`, and `additional` dict. Most configuration lives in the
settings system, not here.

---

## 4. Hierarchical Agent Delegation

### 4.1 How It Works

The `call_subordinate` tool (`tools/call_subordinate.py`) is the mechanism for
hierarchical delegation. When the LLM decides it needs help, it outputs:

```json
{
  "tool_name": "call_subordinate",
  "tool_args": {
    "message": "Research X and report back",
    "agent_profile": "researcher"
  }
}
```

### 4.2 Delegation Flow

```
Agent A0 (number=0, profile="default")
    |
    +-- monologue loop iteration N
    |     LLM outputs: call_subordinate(message, profile="researcher")
    |
    +-- Delegation.execute():
    |     |
    |     +-- Create Agent A1 (number=1, config with profile="researcher")
    |     +-- A1.set_data("_superior", A0)
    |     +-- A0.set_data("_subordinate", A1)
    |     +-- A1.hist_add_user_message(message)
    |     +-- result = await A1.monologue()     <-- A1 runs its own full loop
    |     +-- A1.history.new_topic()            <-- seal topic for compression
    |     +-- return Response(result, break_loop=False)
    |
    +-- Tool result added to A0's history
    +-- A0's monologue loop continues (iteration N+1)
```

### 4.3 Context Inheritance & Isolation

| Aspect | Shared | Isolated |
|--------|--------|----------|
| `AgentContext` | **Same context** — parent and child share the same context | — |
| `Log` | **Same log** — both write to the same Log instance | — |
| `History` | — | **Separate** — each Agent has its own History |
| `data` dict | — | **Separate** — but cross-linked via `_superior`/`_subordinate` |
| `config` | — | **Separate** — subordinate gets fresh config; profile can differ |
| Prompt templates | — | **Profile-dependent** — subordinate loads prompts from its own profile dirs |
| Memory (FAISS) | **Shared** — memory subdir is per-context, not per-agent | — |
| MCP tools | **Shared** — MCPConfig is a process-wide singleton | — |

### 4.4 Recursive Unwinding

When a subordinate completes, its final response string propagates back up the
chain via `_process_chain`. If the subordinate itself spawned a sub-subordinate,
the recursion unwinds naturally:

```
_process_chain(A2, msg)
    A2.monologue() -> response
    superior = A2.data["_superior"] = A1
    _process_chain(A1, response, user=False)
        A1 receives tool result
        A1.monologue() -> response
        superior = A1.data["_superior"] = A0
        _process_chain(A0, response, user=False)
            A0 receives tool result
            A0.monologue() -> final response
            no superior -> return
```

This chain reconstruction happens in `AgentContext._process_chain()` and is
specifically designed to survive chat serialization/deserialization — if the
original call stack is lost (e.g., chat loaded from file), the chain rebuilds
from the `_superior` data links.

### 4.5 Depth

There is **no hard depth limit**. A subordinate can call its own subordinate
(A0 → A1 → A2 → ...). Each level gets `number = parent.number + 1`. The depth
is limited only by context window budget and practical LLM capability.

### 4.6 Agent Profiles

Profiles control which prompts, tools, and extensions a subordinate uses. The
resolution order for any resource (prompt, tool, extension) is:

```
1. project/agents/<profile>/...        (project-specific override)
2. project/.a0proj/...                 (project-level default)
3. usr/agents/<profile>/...            (user customization)
4. plugins/*/agents/<profile>/...      (plugin-provided)
5. agents/<profile>/...                (built-in profile)
6. usr/...                             (user global)
7. plugins/*/...                       (plugin global)
8. ./...                               (repository root default)
```

Built-in profiles include: `default`, `developer`, `hacker`, `researcher`,
`agent0`, and `_example`.

---

## 5. Memory Subsystem

### 5.1 Architecture

```
+------------------+     +-------------------+     +------------------+
|  Memory Plugin   |     |  Memory Class     |     |  FAISS (MyFaiss) |
|  (extensions)    |---->|  (memory.py)      |---->|  (vector store)  |
|                  |     |                   |     |                  |
| monologue_start: |     | search_similarity |     | IndexFlatIP      |
|   init DB        |     | insert_text       |     | COSINE distance  |
|                  |     | insert_documents  |     | InMemoryDocstore |
| prompts_after:   |     | delete_by_query   |     | save_local()     |
|   recall memories|     | delete_by_ids     |     | load_local()     |
|                  |     | update_documents  |     +------------------+
| monologue_end:   |     | preload_knowledge |
|   memorize frags |     +-------------------+
|   memorize solns |              |
+------------------+     +-------------------+
                         |  Embedding Model  |
                         | (CacheBackedEmbed)|
                         | LiteLLM provider  |
                         +-------------------+
```

### 5.2 Memory Areas

| Area | Purpose | When Written |
|------|---------|-------------|
| `MAIN` | General knowledge, user-saved memories | Manual via `memory_save` tool |
| `FRAGMENTS` | Auto-extracted information fragments | End of monologue (background) |
| `SOLUTIONS` | Problem/solution pairs | End of monologue (background) |

### 5.3 Memory Lifecycle

**Initialization** — At `monologue_start`, the `_10_memory_init` extension
eagerly calls `Memory.get(agent)`. This either loads an existing FAISS index
from `usr/memory/<subdir>/` or creates a fresh one. Embeddings are cached via
`CacheBackedEmbeddings` to avoid redundant API calls.

**Knowledge preloading** — On first init, knowledge files from `knowledge/`
directories are chunked, embedded, and inserted. An import index
(`knowledge_import.json`) tracks file hashes to detect changes, avoiding
re-embedding unchanged files.

**Recall** — At `message_loop_prompts_after` (every Nth iteration, configurable
via `memory_recall_interval`):

```
1. Utility LLM generates search queries from conversation history
2. FAISS cosine similarity search with configurable threshold
3. Optional AI-based post-filtering of results
4. Results injected as "extras" into the prompt context
```

**Memorization** — At `monologue_end`, two parallel background tasks:
- `_50_memorize_fragments`: LLM extracts factual fragments → stored in FRAGMENTS area
- `_51_memorize_solutions`: LLM extracts problem/solution pairs → stored in SOLUTIONS area

Both support two storage modes:
- **Intelligent consolidation** (default): LLM merges new memories with similar
  existing ones, producing consolidated entries
- **Simple replace**: delete similar existing entries by threshold, insert new ones

**Manual operations** — Five tools exposed to the agent:
- `memory_save` — insert text with metadata
- `memory_load` — search by query with threshold
- `memory_delete` — delete by ID
- `memory_forget` — delete by similarity query
- `behaviour_adjustment` — update persistent behaviour rules (stored as markdown)

### 5.4 Memory Scoping

Memory is scoped by `memory_subdir`, derived from the agent profile. Projects
get their own memory directory at `<project>/.a0proj/memory/`. All agents within
a context share the same memory (there is no per-subordinate memory isolation).

### 5.5 Embedding Model Handling

If the embedding model changes (provider or name), the entire FAISS index is
re-embedded from existing documents — the `embedding.json` metadata file tracks
which model was used. This prevents vector space mismatches.

---

## 6. Extension System

### 6.1 Two Mechanisms

**Explicit extension points** — Named hooks like `"monologue_start"`,
`"system_prompt"`, `"tool_execute_before"`. Code calls
`call_extensions_async("hook_name", agent, **kwargs)` and all matching
`Extension` subclasses are instantiated and executed in filename-order.

**Implicit extension points** — The `@extensible` decorator on any function
auto-generates `start` and `end` hooks at
`_functions/<module>/<qualname>/start|end`. Extensions at these paths can
mutate arguments (`data["args"]`, `data["kwargs"]`), short-circuit the
function (`data["result"]`), or replace exceptions (`data["exception"]`).

### 6.2 Extension Resolution

Extensions are Python files containing `Extension` subclasses. They are
discovered by scanning directories in the same priority order as agent profiles:

```
project/agents/<profile>/extensions/python/<hook>/
project/.a0proj/extensions/python/<hook>/
usr/agents/<profile>/extensions/python/<hook>/
plugins/*/agents/<profile>/extensions/python/<hook>/
agents/<profile>/extensions/python/<hook>/
usr/extensions/python/<hook>/
plugins/*/extensions/python/<hook>/
extensions/python/<hook>/
```

Files are loaded via `importlib`, classes extracted, and **deduplicated by
filename** — the first occurrence (highest priority) wins. This means a user
extension with the same filename as a built-in one completely replaces it.

### 6.3 Execution Order

Files are sorted by name. Convention is `_NN_name.py` where NN controls order.
Lower numbers run first. All extensions for a hook run sequentially (not
parallel).

### 6.4 Complete Extension Point Catalog

**Core loop hooks:**

| Hook | When | Typical Use |
|------|------|-------------|
| `monologue_start` | Before first iteration | Memory init, preloading |
| `message_loop_start` | Each iteration start | Iteration counting |
| `message_loop_prompts_before` | Before prompt assembly | — |
| `system_prompt` | During prompt assembly | Add system prompt sections |
| `message_loop_prompts_after` | After prompt assembly | Memory recall, deferred injection |
| `before_main_llm_call` | Before LLM inference | — |
| `reasoning_stream_chunk` | Each reasoning token | Filtering, masking |
| `reasoning_stream_end` | Reasoning complete | — |
| `response_stream_chunk` | Each response token | Filtering, masking |
| `response_stream_end` | Response complete | — |
| `tool_execute_before` | Before tool runs | Preprocessing tool args |
| `tool_execute_after` | After tool runs | Postprocessing tool results |
| `message_loop_end` | Each iteration end | History compression, chat save |
| `monologue_end` | Loop exits | Memorization, UI state |
| `process_chain_end` | Full chain done | Final cleanup |

**Agent lifecycle hooks:**

| Hook | When |
|------|------|
| `agent_init` | Agent constructor |
| `hist_add_before` | Before message added to history |
| `hist_add_tool_result` | Before tool result added to history |

**Implicit (`@extensible`) hooks currently used:**

| Function | start/end | Implementation |
|----------|-----------|----------------|
| `__main__.init_a0()` | end | Register filesystem watchdogs |
| `Agent.handle_exception()` | end | Exception type dispatch (intervention, repairable, critical) |

---

## 7. MCP Integration (Server + Client)

### 7.1 A0 as MCP Server

Agent Zero exposes itself as an MCP-compatible server at `/mcp`, allowing
external agents/tools to interact with it over SSE or Streamable HTTP.

```
External MCP Client
    |
    +-- /mcp/t-{TOKEN}/sse          --> SSE transport
    +-- /mcp/t-{TOKEN}/http         --> Streamable HTTP transport
    +-- /mcp/t-{TOKEN}/p-{PROJECT}/ --> Project-scoped variant
    |
    v
DynamicMcpProxy (ASGI middleware)
    |
    +-- validates token from URL path
    +-- extracts project name from URL path (if present)
    +-- strips routing prefix, forwards to FastMCP app
    |
    v
FastMCP server instance
    |
    +-- send_message(message, chat_id?, project?, ...)
    |     Creates/reuses AgentContext, runs full monologue, returns response
    |
    +-- finish_chat(chat_id)
          Removes chat, cleans up context
```

**Authentication:** Token-based, embedded in URL path. The token is generated at
startup and stored in settings (`mcp_server_token`). The middleware refuses
requests with mismatched tokens.

**Project scoping:** Optional `/p-{project}/` segment in the URL sets a
`contextvars.ContextVar` that the `send_message` tool reads to scope the chat
to a specific project.

### 7.2 A0 as MCP Client

Agent Zero can connect to external MCP servers as a client, making remote tools
available to the agent as if they were local.

```
settings.mcp_servers (JSON config)
    |
    v
MCPConfig.update() --> parses config
    |
    +-- For each server:
    |     +-- MCPServerLocal:  stdio transport (subprocess)
    |     +-- MCPServerRemote: SSE or Streamable HTTP transport
    |
    +-- MCPClientBase.connect()
    |     +-- Opens transport
    |     +-- Discovers tools via list_tools()
    |     +-- Registers each tool in MCPConfig._tools dict
    |
    v
Agent's process_tools() checks MCPConfig before local tools
    |
    +-- mcp_handler.MCPConfig.get_tool(agent, tool_name)
    +-- If found: returns MCPTool wrapping the remote call
    +-- If not: falls through to local tool resolution
```

**Dynamic header resolution:** An extension hook (`resolve_mcp_server_headers`)
allows plugins to resolve placeholders in MCP server headers at connection time
(e.g., injecting secrets).

**MCP tools appear in the system prompt.** The `_12_mcp_prompt` extension
queries MCPConfig for all registered tools and injects their descriptions into
the system prompt, so the LLM knows they exist.

---

## 8. A2A (Agent-to-Agent) Protocol

Agent Zero supports the A2A protocol in both directions:

### 8.1 A0 as A2A Server

Mounted at `/a2a` via `DynamicA2AProxy`. Uses the `fasta2a` library. External
A2A-compatible agents can discover A0's capabilities and send tasks.

### 8.2 A0 as A2A Client

The `a2a_chat` tool allows the agent to connect to remote A2A-compatible agents:

```json
{
  "tool_name": "a2a_chat",
  "tool_args": {
    "agent_url": "http://remote-agent:8080/a2a",
    "message": "Analyze this dataset"
  }
}
```

**Session persistence:** The tool maintains a `_a2a_sessions` map on the agent's
data store, keyed by remote URL. This enables multi-turn conversations across
calls. A `reset` flag drops the stored context.

---

## 9. Tool System — Brief Overview

Tools are Python classes extending `helpers/tool.py:Tool`. The LLM outputs JSON:

```json
{"tool_name": "code_execution", "tool_args": {"runtime": "python", "code": "..."}}
```

Tool resolution order:
1. **MCP tools** — checked first via `MCPConfig.get_tool()`
2. **Local tools** — resolved by searching `tools/<name>.py` in the agent's profile path hierarchy

The `Tool` base class provides `before_execution()` (logging), `execute()` (abstract), and `after_execution()` (history + logging). The `Response` dataclass has `message` (string result) and `break_loop` (boolean — only `response` tool sets this `True`).

Built-in tools: `response`, `call_subordinate`, `code_execution` (plugin), `memory_*` (plugin), `search_engine`, `browser_*` (plugin), `a2a_chat`, `scheduler`, `skills_tool`, `notify_user`, `document_query`, `vision_load`, `wait`, `behaviour_adjustment` (plugin), `text_editor` (plugin).

Files with `._py` suffix (e.g., `browser._py`) are disabled by convention.

---

## 10. Configuration & Settings — Brief Overview

- **`helpers/settings.py`** — `Settings` TypedDict with ~80 fields. Defaults via `get_default_settings()`.
- **`.env` file** — `RFC_PASSWORD`, plus `A0_SET_*` prefix overrides any setting.
- **Web UI** — Settings page writes to `usr/cfg/settings.json`.
- **Model providers** — `conf/model_providers.yaml` lists available LLM providers. Actual model config lives in the `_model_config` plugin.
- **Per-project / per-agent config** — Plugins can declare `per_project_config: true` and `per_agent_config: true` in `plugin.yaml` to get layered configuration.

---

## 11. Prompt Template System — Brief Overview

Prompts are Markdown files with `{{variable}}` substitution and `{{ include file.md }}` directives. Loaded via `files.read_prompt_file()` which searches the profile path hierarchy. A `files.parse_file()` variant produces structured dict output from JSON-template files (used for multi-part messages like user messages with attachments).

System prompt assembly order (from `system_prompt` extensions):
1. `_10` — Main agent identity (`agent.system.main.md`)
2. `_11` — Tool descriptions (`agent.system.tools.md` + `agent.system.tool.*.md`)
3. `_12` — MCP tool descriptions (dynamic from MCPConfig)
4. `_13` — Secrets/variables + Skills list
5. `_14` — Project context
6. `_20` — Behaviour rules (from memory plugin, per-agent `behaviour.md`)

---

## 12. Docker/RFC Execution — Brief Overview

When running locally in development mode, code execution tools delegate to a
Docker container via SSH (terminal commands) and RFC (HTTP remote function
calls). The container runs the full A0 stack (Kali Linux, SearXNG, sshd) but
the local instance only uses it as an execution sandbox.

Configuration: `rfc_url`, `rfc_port_http`, `rfc_port_ssh`, `RFC_PASSWORD` (in `.env`).

---

## 13. Architectural Trade-offs & Limitations

### Strengths

- **Deep extensibility.** The `@extensible` decorator + explicit extension points
  mean virtually any behavior can be overridden without forking. The filename-based
  deduplication makes overrides clean.

- **Clean hierarchical delegation.** Sub-agents get isolated histories but shared
  context/memory, which is the right tradeoff for most use cases.

- **Protocol-rich.** Native MCP server + client + A2A support in a single process
  is architecturally elegant and rare in this space.

- **Plugin architecture.** The plugin system (discovery, toggle files, layered
  config, per-project/per-agent scoping) is well-designed for extensibility.

### Weaknesses & Risks

- **Single-process, in-memory state.** All agent contexts, memory indexes, and
  MCP connections live in a single Python process. No horizontal scaling. A crash
  loses all running conversations (chat persistence mitigates but doesn't
  eliminate this). No multi-worker support.

- **No iteration/depth limits in core.** The monologue loop has no built-in
  iteration cap. A misbehaving LLM can spin indefinitely. The repeat-detection
  mechanism (warn if response equals last response) is the only guardrail, and
  it only detects exact duplicates.

- **Tight coupling to LiteLLM + LangChain.** While LiteLLM supports many
  providers, the history system uses LangChain message types
  (`HumanMessage`, `AIMessage`, `SystemMessage`), and embeddings use
  `langchain_community.vectorstores.FAISS`. Migration away from either would be
  significant work.

- **Extension ordering is fragile.** Execution order depends on filename sorting
  (`_10_`, `_50_`, `_90_`). There's no dependency declaration between extensions.
  Inserting a new extension between existing ones requires renaming files.

- **Memory recall latency.** Every Nth iteration, the memory recall pipeline
  makes a full utility LLM call to generate search queries, then a FAISS search,
  then optionally another LLM call for post-filtering. This adds latency to
  those iterations. The "delayed recall" mode mitigates this but at the cost of
  one iteration being informed by stale context.

- **FAISS limitations.** No server mode — the entire index must fit in process
  memory. No incremental persistence — the full index is rewritten on every
  insert/delete. No concurrent write safety beyond Python's GIL.

- **Prompt template system lacks type safety.** `{{variable}}` substitution is
  string-based with no validation that all required variables are provided. A
  typo in a variable name silently produces an empty string.

- **MCP client connections are long-lived.** MCP clients maintain persistent
  connections (stdio subprocesses or HTTP sessions). There's no health checking
  or automatic reconnection for remote servers. A failed connection requires
  manual reconfiguration.

- **JSON-only tool interface.** The LLM must output valid JSON for every action.
  This wastes tokens on formatting and means the agent cannot produce free-form
  text responses without wrapping them in a `response` tool call. The
  `dirty_json` parser provides resilience against minor formatting issues, but
  fundamentally misaligned models will struggle.

- **History compression is LLM-dependent.** Summarization quality depends on the
  utility model. Bad summaries compound over time as they get re-summarized in
  bulk compression. There's no human-in-the-loop validation of summaries.

---

*End of document.*
