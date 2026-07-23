import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

// ---------------------------------------------------------------------------
// Tool / command identity — verbatim string boundaries.
// Tool name "todo" is the persistence key for branch replay (filtering
// `toolResult.toolName === "todo"`) AND the permissions entry at
// `templates/pi-permissions.jsonc:26`. DO NOT rename.
// ---------------------------------------------------------------------------

export const TOOL_NAME = "todo";
export const TOOL_LABEL = "Todo";
export const COMMAND_NAME = "todos";

// ---------------------------------------------------------------------------
// User-facing strings (kept stable for /todos UX parity).
// ---------------------------------------------------------------------------

export const ERR_REQUIRES_INTERACTIVE = "/todos requires interactive mode";
export const MSG_NO_TODOS = "No todos yet. Ask the agent to add some!";

// ---------------------------------------------------------------------------
// Public domain types
// ---------------------------------------------------------------------------

export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export type TaskAction = "create" | "update" | "list" | "get" | "delete" | "clear";

export interface Task {
	id: number;
	subject: string;
	description?: string;
	activeForm?: string;
	status: TaskStatus;
	blockedBy?: number[];
	owner?: string;
	metadata?: Record<string, unknown>;
}

/**
 * Persistence + replay snapshot. Every successful `todo` tool call returns this
 * shape under `details`; `state/replay.ts` reads the latest one from the branch
 * to reconstruct module state. Field order and field names are pinned by
 * cross-version replay compatibility.
 */
export interface TaskDetails {
	action: TaskAction;
	params: Record<string, unknown>;
	tasks: Task[];
	nextId: number;
	error?: string;
}

/**
 * Open-shape input bag the reducer accepts. Stays an interface so the index
 * signature (`[key: string]: unknown`) lets the runtime pass through TypeBox
 * `Static<typeof TodoParamsSchema>` without `as` casts.
 */
export interface TaskMutationParams {
	[key: string]: unknown;
	subject?: string;
	description?: string;
	activeForm?: string;
	status?: TaskStatus;
	blockedBy?: number[];
	addBlockedBy?: number[];
	removeBlockedBy?: number[];
	owner?: string;
	metadata?: Record<string, unknown>;
	id?: number;
	includeDeleted?: boolean;
}

// ---------------------------------------------------------------------------
// TypeBox parameter schema — every `description` doubles as LLM-facing prompt
// copy. Field order and wording are pinned by registration tests and the
// pre-refactor schema at `packages/rpiv-todo/todo.ts:512-573`.
// ---------------------------------------------------------------------------

// Shared field definitions (descriptions double as LLM-facing prompt copy).
const SubjectField = Type.String({ description: "Task subject line (required for create)" });
const DescriptionField = Type.String({ description: "Long-form task description" });
const ActiveFormField = Type.String({
	description: "Present-continuous spinner label shown while status is in_progress (e.g. 'writing tests')",
});
const StatusField = StringEnum(["pending", "in_progress", "completed", "deleted"] as const, {
	description: "Target status",
});
const OwnerField = Type.String({ description: "Agent/owner assigned to this task" });
const MetadataField = Type.Record(Type.String(), Type.Unknown(), {
	description: "Arbitrary metadata; pass null value for a key to delete that key on update",
});
const IdField = Type.Number({ description: "Task id" });
const AddBlockedByField = Type.Array(Type.Number(), {
	description: "Task ids to add to blockedBy (additive merge)",
});
const RemoveBlockedByField = Type.Array(Type.Number(), {
	description: "Task ids to remove from blockedBy (additive merge)",
});

// Discriminated union on `action`: each variant requires exactly the fields
// that action needs. An `update` with NO mutable field (e.g. only
// {action, id, includeDeleted}) is unrepresentable — includeDeleted exists
// ONLY on the list variant.
const CreateSchema = Type.Object({
	action: Type.Literal("create"),
	subject: SubjectField,
	description: Type.Optional(DescriptionField),
	activeForm: Type.Optional(ActiveFormField),
	blockedBy: Type.Optional(Type.Array(Type.Number(), { description: "Initial blockedBy ids" })),
	owner: Type.Optional(OwnerField),
	metadata: Type.Optional(MetadataField),
});

const UpdateSchema = Type.Intersect([
	Type.Object({
		action: Type.Literal("update"),
		id: IdField,
		subject: Type.Optional(SubjectField),
		description: Type.Optional(DescriptionField),
		activeForm: Type.Optional(ActiveFormField),
		status: Type.Optional(StatusField),
		addBlockedBy: Type.Optional(AddBlockedByField),
		removeBlockedBy: Type.Optional(RemoveBlockedByField),
		owner: Type.Optional(OwnerField),
		metadata: Type.Optional(MetadataField),
	}),
	// At least one mutable field is REQUIRED.
	Type.Union(
		[
			Type.Object({ subject: SubjectField }),
			Type.Object({ description: DescriptionField }),
			Type.Object({ activeForm: ActiveFormField }),
			Type.Object({ status: StatusField }),
			Type.Object({ owner: OwnerField }),
			Type.Object({ metadata: MetadataField }),
			Type.Object({ addBlockedBy: AddBlockedByField }),
			Type.Object({ removeBlockedBy: RemoveBlockedByField }),
		],
		{ description: "update MUST set at least one mutable field" },
	),
]);

const ListSchema = Type.Object({
	action: Type.Literal("list"),
	status: Type.Optional(
		StringEnum(["pending", "in_progress", "completed", "deleted"] as const, {
			description: "Filter to a single status",
		}),
	),
	includeDeleted: Type.Optional(
		Type.Boolean({
			description: "If true, also return deleted (tombstoned) tasks. List action ONLY. Default: false.",
		}),
	),
});

const GetSchema = Type.Object({
	action: Type.Literal("get"),
	id: IdField,
});

const DeleteSchema = Type.Object({
	action: Type.Literal("delete"),
	id: IdField,
});

const ClearSchema = Type.Object({
	action: Type.Literal("clear"),
});

export const TodoParamsSchema = Type.Union(
	[CreateSchema, UpdateSchema, ListSchema, GetSchema, DeleteSchema, ClearSchema],
	{ description: "Todo actions. update requires id + at least one mutable field; includeDeleted is list-only." },
);

export type TodoParams = Static<typeof TodoParamsSchema>;
