/**
 * todo tool + /todos command — thin registration shell.
 *
 * Tool/command identity, schema, types, reducer, store, replay, response
 * envelope, selectors, and view formatters live in the layered modules under
 * `tool/`, `state/`, and `view/`. This file is the package-root registration
 * surface — it mirrors `packages/rpiv-ask-user-question/ask-user-question.ts`
 * which keeps the tool registration at the package root.
 *
 * Public re-exports below preserve the pre-refactor import surface so that
 * `index.ts`, `todo-overlay.ts`, and the global `test/setup.ts` `beforeEach`
 * continue to import from `./todo.js`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, validateGuidanceFields } from "./config.js";
import { formatStatusLabel, t } from "./state/i18n-bridge.js";
import { replayFromBranch } from "./state/replay.js";
import { selectTasksByStatus, selectTodoCounts, selectVisibleTasks } from "./state/selectors.js";
import { applyTaskMutation } from "./state/state-reducer.js";
import { commitState, getState, replaceState } from "./state/store.js";
import { buildToolResult } from "./tool/response-envelope.js";
import {
	COMMAND_NAME,
	ERR_REQUIRES_INTERACTIVE,
	MSG_NO_TODOS,
	type TaskMutationParams,
	TOOL_LABEL,
	TOOL_NAME,
	TodoParamsSchema,
} from "./tool/types.js";
import { formatCommandTaskLine, renderTodoCall, renderTodoResult } from "./view/format.js";

// English fallbacks for localized /todos section headers — the box-drawing
// decoration is part of the localized string so translators can adjust spacing.
const SECTION_PENDING = "── Pending ──";
const SECTION_IN_PROGRESS = "── In Progress ──";
const SECTION_COMPLETED = "── Completed ──";

// ---------------------------------------------------------------------------
// Public re-exports — pre-refactor consumers (overlay, tests, index.ts) keep
// importing from `./todo.js`. New code may opt into deeper imports.
// ---------------------------------------------------------------------------

export { isTransitionValid } from "./state/invariants.js";
export { applyTaskMutation } from "./state/state-reducer.js";
export { __resetState, getNextId, getTodos } from "./state/store.js";
export { deriveBlocks, detectCycle } from "./state/task-graph.js";
export type { Task, TaskAction, TaskDetails, TaskStatus } from "./tool/types.js";
export { TOOL_NAME } from "./tool/types.js";

/**
 * Backward-compat replay shim. Pre-refactor `reconstructTodoState(ctx)`
 * mutated module state directly; the new replay seam (`state/replay.ts`)
 * returns a `TaskState` and the caller commits via `replaceState`.
 */
export function reconstructTodoState(ctx: Parameters<typeof replayFromBranch>[0]): void {
	replaceState(replayFromBranch(ctx));
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export const DEFAULT_PROMPT_SNIPPET = "Manage a task list to track multi-step progress";
export const DEFAULT_PROMPT_GUIDELINES: string[] = [
	"Use `todo` for complex work with 3+ steps, when the user gives you a list of tasks, or immediately after receiving new instructions to capture requirements. Skip it for single trivial tasks and purely conversational requests.",
	"When starting any task, mark it in_progress BEFORE beginning work. Mark it completed IMMEDIATELY when done — never batch completions. Exactly one task should be in_progress at a time.",
	"Never mark a task completed if tests are failing, the implementation is partial, or you hit unresolved errors — keep it in_progress and create a new task for the blocker instead.",
	"Task status is a 4-state machine: pending → in_progress → completed, plus deleted as a tombstone. Pass activeForm (present-continuous label, e.g. 'researching existing tool') when marking in_progress.",
	"Use blockedBy to express dependencies (A is blocked by B). On create, pass blockedBy as the initial set. On update, use addBlockedBy / removeBlockedBy (additive merge — do not resend the full array). Cycles are rejected.",
	"list hides tombstoned (deleted) tasks by default; pass includeDeleted:true to see them. Pass status to filter by a single status. includeDeleted is valid for the list action ONLY.",
	"Subject must be short and imperative (e.g. 'Research existing tool'); description is for long-form detail. activeForm is a present-continuous label shown while in_progress.",
	"The todo list is a DELIVERABLE, not a scratchpad: it is user-visible UI state (widgets, /todos, and session summaries render it). It must reflect reality at all times. Never abandon it and track state in prose instead — prose is invisible to everything downstream.",
	"If a todo call fails, TRUST the error message: it names the exact fields the tool received. The tool executes exactly what you send; params are never stripped or dropped. NEVER retry an identical failing call — change the fields or run a different action (e.g. list) first.",
];

// Loop detector: models occasionally get stuck re-emitting the exact same
// failing call while narrating that they changed it. Identical failing calls
// escalate with an explicit loop warning instead of the same quiet error.
let lastFailureSig: string | null = null;
let lastFailureCount = 0;

export function registerTodoTool(pi: ExtensionAPI): void {
	const guidance = validateGuidanceFields(loadConfig().guidance);
	pi.registerTool({
		name: TOOL_NAME,
		label: TOOL_LABEL,
		description:
			"Manage a task list for tracking multi-step progress. This list is user-visible UI state — a deliverable that must stay accurate. Actions: create (new task), update (change status/fields/dependencies — requires id plus at least one mutable field), list (all tasks, optionally filtered by status; only list accepts includeDeleted), get (single task details), delete (tombstone), clear (reset all). Status: pending → in_progress → completed, plus deleted tombstone. Use this to plan and track multi-step work like research, design, and implementation.",
		promptSnippet: guidance.promptSnippet ?? DEFAULT_PROMPT_SNIPPET,
		promptGuidelines: guidance.promptGuidelines ?? DEFAULT_PROMPT_GUIDELINES,
		parameters: TodoParamsSchema,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const result = applyTaskMutation(getState(), params.action, params as TaskMutationParams);
			commitState(result.state);
			const envelope = buildToolResult(params.action, params as TaskMutationParams, result.state, result.op);
			if (result.op.kind === "error") {
				const sig = JSON.stringify(params);
				if (sig === lastFailureSig) {
					lastFailureCount++;
					envelope.content[0].text +=
						`\n\nLOOP DETECTED: this exact call has now failed ${lastFailureCount + 1} times in a row. ` +
						`It will NEVER succeed — the tool runs exactly the params you send. ` +
						`Do NOT retry it unchanged: run a different action (e.g. list), or change the fields. ` +
						`Do NOT abandon the todo tool and track state in prose — the list is user-visible UI state.`;
				} else {
					lastFailureSig = sig;
					lastFailureCount = 0;
				}
			} else {
				lastFailureSig = null;
				lastFailureCount = 0;
			}
			return envelope;
		},

		renderCall(args, theme, _context) {
			return renderTodoCall(args as never, theme, getState());
		},

		renderResult(result, _opts, theme, _context) {
			return renderTodoResult(result, theme);
		},
	});
}

// ---------------------------------------------------------------------------
// /todos slash command
// ---------------------------------------------------------------------------

export function registerTodosCommand(pi: ExtensionAPI): void {
	pi.registerCommand(COMMAND_NAME, {
		description: "Show all todos on the current branch, grouped by status",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify(t("command.requires_interactive", ERR_REQUIRES_INTERACTIVE), "error");
				return;
			}
			const state = getState();
			const visible = selectVisibleTasks(state);
			if (visible.length === 0) {
				ctx.ui.notify(t("command.no_todos", MSG_NO_TODOS), "info");
				return;
			}
			const groups = selectTasksByStatus(state);
			const counts = selectTodoCounts(state);

			const header: string[] = [];
			if (counts.completed > 0) header.push(`${counts.completed}/${counts.total} ${formatStatusLabel("completed")}`);
			if (counts.inProgress > 0) header.push(`${counts.inProgress} ${formatStatusLabel("in_progress")}`);
			if (counts.pending > 0) header.push(`${counts.pending} ${formatStatusLabel("pending")}`);

			const lines: string[] = [header.join(" · ")];
			if (groups.pending.length > 0) {
				lines.push(t("command.section.pending", SECTION_PENDING));
				for (const task of groups.pending) lines.push(formatCommandTaskLine(task, "○"));
			}
			if (groups.inProgress.length > 0) {
				lines.push(t("command.section.in_progress", SECTION_IN_PROGRESS));
				for (const task of groups.inProgress) lines.push(formatCommandTaskLine(task, "◐"));
			}
			if (groups.completed.length > 0) {
				lines.push(t("command.section.completed", SECTION_COMPLETED));
				for (const task of groups.completed) lines.push(formatCommandTaskLine(task, "✓"));
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
