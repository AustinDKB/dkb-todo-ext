# rpiv-todo (hardened fork)

> **This repo (`dkb-todo-ext`) is a hardened copy of `@juicesharp/rpiv-todo`.** See [What's changed in this fork](#whats-changed-in-this-fork) below. Everything else — features, install, overlay, localization — is unchanged from upstream.

<div align="center">
  <a href="https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo">
    <picture>
      <img src="https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-todo/docs/cover.png" alt="rpiv-todo cover" width="50%">
    </picture>
  </a>
</div>

Give the model a todo list it can keep across long sessions. `rpiv-todo` adds the `todo` tool, the `/todos` slash command, and a live overlay above the editor to [Pi Agent](https://github.com/badlogic/pi-mono) - tasks survive `/reload` and conversation compaction, so the model picks up where it left off.

![Todo overlay widget above the Pi editor](https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-todo/docs/overlay.jpg)

## What's changed in this fork

Four changes, all motivated by an observed agent failure: a model repeatedly emitted `todo({action:"update", id:1, includeDeleted:false})` — while *believing* it was sending `status:"completed"` — misdiagnosed the resulting error as "the harness is dropping my params", retried the identical call in a loop, then gave up on the tool entirely and tracked task state in prose (silently desyncing the todo UI from reality). Root cause was model-side repetition fixation, but the tool's flat all-optional schema and terse error gave the loop nothing to collide with. Each change below targets one stage of that cascade:

### 1. Stronger schema — discriminated union per action (`tool/types.ts`)

The flat all-optional object was replaced with a union of six per-action variants. Consequences:

- **`update` requires `id` plus at least one mutable field** (`status`, `subject`, `description`, `activeForm`, `owner`, `metadata`, `addBlockedBy`, or `removeBlockedBy`) — expressed as an `allOf` + `anyOf` in the JSON Schema the model sees.
- **`includeDeleted` exists only on the `list` variant.** The exact call that looped (`{action:"update", id, includeDeleted:false}`) is now unrepresentable against the tool definition.

Note: pi does not validate tool args against the schema before execution, so this steers the model via the model-facing JSON Schema rather than rejecting calls pre-dispatch — which is why changes 2 and 3 exist as enforcement layers.

### 2. Error messages echo what was actually received (`state/state-reducer.ts`)

The old `"update requires at least one mutable field"` left room for the model to invent a transmission-bug theory. The rejection now names the exact fields the tool received, states plainly that params are never stripped, notes that `includeDeleted` is list-only, and lists the corrective fields:

```
update(#1) rejected: no mutable field was set. Fields actually received: [id, includeDeleted].
The tool executes EXACTLY the params it receives — nothing is stripped or dropped.
includeDeleted is valid for the list action only; it is ignored here.
Retry with a DIFFERENT call that sets at least one of: status, subject, description, ...
```

### 3. Repetition-loop detector (`todo.ts` execute path)

Identical failing calls (byte-equal params) no longer return the same quiet error. The second and subsequent occurrences get an escalating warning appended:

```
LOOP DETECTED: this exact call has now failed N times in a row. It will NEVER succeed —
the tool runs exactly the params you send. Do NOT retry it unchanged: run a different
action (e.g. list), or change the fields. Do NOT abandon the todo tool and track state
in prose — the list is user-visible UI state.
```

The counter resets on any successful call or a changed signature.

### 4. Deliverable framing + anti-loop rules in model-facing copy (`todo.ts`)

The tool description and prompt guidelines now state that the todo list is **user-visible UI state — a deliverable that must stay accurate** (widgets, `/todos`, and session summaries render it), that error messages should be trusted over the model's own narration, and that an identical failing call must never be retried verbatim.

## Features

- **Live overlay above the editor** - see the model's plan at all times; completed items stay visible until the next agent response starts, then fall away; auto-hides when empty.
- **Survives `/reload` and compaction** - tasks replay from the conversation branch, not disk.
- **Status states** - pending, in_progress, completed, plus a deleted tombstone for audit.
- **Dependency tracking** - `blockedBy` with cycle detection, so the model can sequence work.
- **Smart truncation** - 12-line collapse threshold; completed tasks drop first, pending tasks stay visible last.

## Install

### This fork (dkb-todo-ext)

The fork registers the same `todo` tool name as upstream, so remove any existing upstream install first — the two cannot coexist:

```bash
pi remove npm:@juicesharp/rpiv-todo        # skip if never installed
pi install git:github.com/AustinDKB/dkb-todo-ext
```

Then restart your Pi session. To go back to upstream:

```bash
pi remove git:github.com/AustinDKB/dkb-todo-ext
pi install npm:@juicesharp/rpiv-todo
```

### Upstream (npm)

```bash
pi install npm:@juicesharp/rpiv-todo
```

Then restart your Pi session.

### Optional: localization

`rpiv-todo` works standalone - install only this package and you get the full English UI. Install `@juicesharp/rpiv-i18n` alongside it to flip the overlay heading, `/todos` section headers, and status words to your active locale:

```bash
pi install npm:@juicesharp/rpiv-i18n
```

With the SDK present, locale resolves from `--locale <code>` → `~/.config/rpiv-i18n/locale.json` → `LANG` / `LC_ALL` → English. The `/languages` interactive picker and `pi --locale <code>` startup flag are also enabled. Without the SDK, the extension stays online and renders English at every call site - no warning, no crash. Users who installed via `pi install npm:@juicesharp/rpiv-pi` + `/rpiv-setup` get the SDK automatically.

## Tool

- **`todo`** - create / update / list / get / delete / clear tasks. 4-state
  machine (pending → in_progress → completed, plus deleted tombstone).
  Supports `blockedBy` dependency tracking with cycle detection. Tasks persist
  via branch replay - survive session compact and `/reload`.

### Schema

```ts
todo({
  action: "create" | "update" | "list" | "get" | "delete" | "clear",

  // create-only
  subject?: string,                // required for create
  blockedBy?: number[],            // initial dependency ids

  // create + update
  description?: string,
  activeForm?: string,             // present-continuous label shown while in_progress
  owner?: string,
  metadata?: Record<string, unknown>, // pass null per key to delete that key on update

  // update-only
  addBlockedBy?: number[],         // additive merge into blockedBy
  removeBlockedBy?: number[],      // additive removal from blockedBy

  // update / get / delete
  id?: number,                     // task id

  // update (target) or list (filter)
  status?: "pending" | "in_progress" | "completed" | "deleted",

  // list-only
  includeDeleted?: boolean,        // default false - hides tombstones
})
```

Valid status transitions: `pending ⇄ in_progress`, either → `completed`, any → `deleted` (terminal). `delete` keeps the task as a tombstone so historic `blockedBy` references still resolve.

Returns:

```ts
{
  content: [{ type: "text", text: string }], // human-readable summary of the op
  details: {                                 // full snapshot - replay reads this back
    action: TaskAction,
    params: Record<string, unknown>,
    tasks: Array<{
      id: number,
      subject: string,
      description?: string,
      activeForm?: string,
      status: "pending" | "in_progress" | "completed" | "deleted",
      blockedBy?: number[],
      owner?: string,
      metadata?: Record<string, unknown>,
    }>,
    nextId: number,
    error?: string,                          // present only on validation/transition failures
  }
}
```

## Commands

- **`/todos`** - print the current todo list grouped by status.

## Overlay

The aboveEditor widget auto-renders whenever any overlay-visible tasks exist.
Completed tasks stay visible after completion until the next agent response
starts, then disappear from later overlay renders. 12-line collapse
threshold; completed tasks still drop first on overflow, pending tasks
truncate last. Auto-hides when the list is empty.

## Localization

`rpiv-todo` localizes its TUI chrome (overlay heading, `/todos` section headers, status words) through `@juicesharp/rpiv-i18n` when the SDK is installed. Bundled locales: `de`, `en`, `es`, `fr`, `pt`, `pt-BR`, `ru`, `uk`. LLM-facing output (tool response envelope, reducer errors, schema descriptions) stays English by design.

The SDK is a soft optional peer - `rpiv-todo` loads it via dynamic import at module init. If the SDK isn't installed, every render call site returns its inline English fallback and the extension stays online with English UI; no warning, no crash. See the Install section for adding the SDK after the fact. To contribute or override translations, see the `@juicesharp/rpiv-i18n` README "Contributing translations" section.

## License

[![npm version](https://img.shields.io/npm/v/@juicesharp/rpiv-todo.svg)](https://www.npmjs.com/package/@juicesharp/rpiv-todo)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

MIT
