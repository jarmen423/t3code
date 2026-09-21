import {
  type MuseSettings,
  type ProviderInteractionMode,
  type ProviderUserInputAnswers,
  ProviderDriverKind,
  type RuntimeMode,
  type UserInputQuestion,
} from "@t3tools/contracts";
import { normalizeModelSlug } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { type AcpSessionModeState, findSessionConfigOption } from "./AcpRuntimeModel.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

/**
 * Product slug for "keep the model Muse is configured with". It is not a
 * native ACP model id and must never reach `session/set_config_option`.
 */
export const MUSE_DEFAULT_MODEL_SLUG = "default";

/** Config option id Muse advertises for the session reasoning ladder. */
export const MUSE_REASONING_EFFORT_CONFIG_ID = "reasoning_effort";

/** Extension request the bridge uses for structured user questions. */
export const MUSE_ELICITATION_CREATE_METHOD = "elicitation/create";

const MUSE_DRIVER_KIND = ProviderDriverKind.make("muse");
const MUSE_DEFAULT_BINARY = "muse-acp-bridge";

type MuseAcpRuntimeMuseSettings = Pick<MuseSettings, "binaryPath">;

export interface MuseAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "cancelBehavior" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly museSettings: MuseAcpRuntimeMuseSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export function buildMuseAcpSpawnInput(
  museSettings: MuseAcpRuntimeMuseSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: museSettings?.binaryPath || MUSE_DEFAULT_BINARY,
    args: [],
    cwd,
    env: { ...environment },
  };
}

/**
 * Muse Code authenticates host-side (`muse login`); the bridge advertises no
 * ACP auth methods and answers `authenticate` with method-not-found, so the
 * resolver always declines to pick one.
 */
export function resolveMuseAuthMethodId(
  _initialize: EffectAcpSchema.InitializeResponse,
): string | undefined {
  return undefined;
}

export const makeMuseAcpRuntime = (
  input: MuseAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildMuseAcpSpawnInput(input.museSettings, input.cwd, input.environment),
        authMethodId: resolveMuseAuthMethodId,
        // The bridge honors session/cancel promptly and drains its own queue;
        // there is no hidden prompt queue to wait out like Hermes has.
        cancelBehavior: "interrupt",
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          // Advertising form elicitation is what makes the bridge forward
          // `elicitation/create` requests instead of auto-cancelling them.
          elicitation: { form: {} },
        },
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

/**
 * T3's permission modes stay conservative on Muse: everything but Full access
 * runs native `ask` so unmatched tools keep asking, and Full access runs
 * `auto`, which allows tools while questions remain available. `yolo` is
 * never selected — it also suppresses Muse's structured questions — and
 * `deny` is never produced, since no T3 mode refuses work outright.
 */
export function musePermissionMode(runtimeMode: RuntimeMode): string {
  return runtimeMode === "full-access" ? "auto" : "ask";
}

// Restrictiveness ladder over the native mode ids Muse is known to use.
// Unknown future ids are never assumed to be safe substitutes.
const MUSE_MODE_LADDER = ["deny", "ask", "auto", "yolo"] as const;

function museModeRank(modeId: string): number {
  return MUSE_MODE_LADDER.indexOf(modeId as (typeof MUSE_MODE_LADDER)[number]);
}

/**
 * Resolves the native mode to apply for a turn, or `undefined` when nothing
 * advertised can enforce the requested authority. `interactionMode ===
 * "plan"` prefers `ask` — Muse has no plan mode, and gating every action is
 * the closest behavior. Without mode metadata or an advertised list the
 * preferred mode is kept; with one, the preferred id wins when advertised,
 * else the most permissive known mode that is not more permissive than
 * requested. When every known advertised mode is more permissive (or only
 * unknown ids are advertised), resolving to `undefined` fails the start or
 * turn instead of widening authority.
 */
export function resolveMuseSessionModeId(input: {
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly modeState: AcpSessionModeState | undefined;
}): string | undefined {
  const preferred =
    input.interactionMode === "plan" ? "ask" : musePermissionMode(input.runtimeMode);
  const advertised = input.modeState?.availableModes ?? [];
  if (advertised.length === 0) {
    return preferred;
  }
  if (advertised.some((mode) => mode.id === preferred)) {
    return preferred;
  }
  const preferredRank = museModeRank(preferred);
  return advertised
    .map((mode) => mode.id)
    .filter((id) => {
      const rank = museModeRank(id);
      return rank >= 0 && rank <= preferredRank;
    })
    .sort((a, b) => museModeRank(b) - museModeRank(a))[0];
}

/**
 * Applies a native mode through `session/set_config_option` (`runtime.setMode`).
 * Skips the request when the mode is already active or was never advertised.
 */
export function applyMuseAcpMode<E>(input: {
  readonly runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "setMode" | "getModeState"
  >;
  readonly modeId: string;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    const modeState = yield* input.runtime.getModeState;
    if (modeState?.currentModeId === input.modeId) return;
    if (modeState !== undefined && !modeState.availableModes.some((m) => m.id === input.modeId)) {
      return;
    }
    yield* input.runtime.setMode(input.modeId).pipe(Effect.mapError(input.mapError));
  });
}

export function resolveMuseAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : MUSE_DEFAULT_MODEL_SLUG;
  return normalizeModelSlug(base, MUSE_DRIVER_KIND) ?? MUSE_DEFAULT_MODEL_SLUG;
}

/** Muse advertises its model list on the `model` session config option. */
export function currentMuseModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  const modelOption = (sessionSetupResult.configOptions ?? []).find(
    (option) => option.category === "model",
  );
  return modelOption?.type === "select" ? modelOption.currentValue.trim() || undefined : undefined;
}

const MUSE_REASONING_EFFORT_TOKEN = /^[a-z0-9][a-z0-9._-]{0,31}$/i;

export function isValidMuseReasoningEffortToken(value: string): boolean {
  return MUSE_REASONING_EFFORT_TOKEN.test(value);
}

export function normalizeMuseReasoningEffort(value: string | null | undefined): string | undefined {
  const effort = value?.trim().toLowerCase();
  return effort && isValidMuseReasoningEffortToken(effort) ? effort : undefined;
}

/** The session's active reasoning level lives on the `reasoning_effort` config option. */
export function currentMuseReasoningEffortFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  const option = findSessionConfigOption(
    sessionSetupResult.configOptions,
    MUSE_REASONING_EFFORT_CONFIG_ID,
  );
  return option?.type === "select" ? normalizeMuseReasoningEffort(option.currentValue) : undefined;
}

export function applyMuseAcpModelSelection<E>(input: {
  readonly runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "setModel" | "setConfigOption"
  >;
  readonly currentModelId: string | undefined;
  readonly currentReasoningEffort?: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly requestedReasoningEffort?: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  // The product slug is never sent over the wire; it keeps the session's model.
  const requestedModelId =
    input.requestedModelId === MUSE_DEFAULT_MODEL_SLUG ? undefined : input.requestedModelId;
  const modelChanged = requestedModelId !== undefined && requestedModelId !== input.currentModelId;
  const reasoningProvided = input.requestedReasoningEffort !== undefined;
  const reasoningEffort = reasoningProvided
    ? normalizeMuseReasoningEffort(input.requestedReasoningEffort)
    : undefined;
  const reasoningEffortChanged =
    reasoningProvided && reasoningEffort !== input.currentReasoningEffort;
  if (!modelChanged && !reasoningEffortChanged) {
    return Effect.succeed(input.currentModelId);
  }
  return Effect.gen(function* () {
    if (modelChanged && requestedModelId !== undefined) {
      yield* input.runtime.setModel(requestedModelId);
    }
    // An invalid effort value is dropped rather than forwarded; an omitted
    // selection must not clear the session's current level.
    if (reasoningEffortChanged && reasoningEffort !== undefined) {
      yield* input.runtime.setConfigOption(MUSE_REASONING_EFFORT_CONFIG_ID, reasoningEffort);
    }
    return requestedModelId ?? input.currentModelId;
  }).pipe(Effect.mapError(input.mapError));
}

const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);
const isAcpTransportError = Schema.is(EffectAcpErrors.AcpTransportError);

/**
 * The bridge has no ACP auth surface, so missing credentials arrive as plain
 * request/transport errors: `-32603` whose message carries the host's
 * `authRequired` kind ("muse login required ..."), plus the spec
 * auth-required `-32000` for completeness.
 */
export function isMuseAuthRequiredError(error: unknown): boolean {
  if (isAcpRequestError(error)) {
    return (
      error.code === -32000 ||
      /authrequired|muse login|credential|unauthorized/i.test(error.message)
    );
  }
  if (isAcpTransportError(error)) {
    return /authrequired|muse login|credential|unauthorized/i.test(error.detail ?? "");
  }
  return false;
}

/**
 * Tolerant decode of the bridge's `elicitation/create` params. Property
 * schemas stay `unknown` so a malformed field fails a single question rather
 * than the whole request.
 */
export const MuseElicitationCreateParams = Schema.Struct({
  sessionId: Schema.optional(Schema.String),
  mode: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  toolCallId: Schema.optional(Schema.String),
  requestedSchema: Schema.optional(
    Schema.Struct({
      type: Schema.optional(Schema.String),
      properties: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
      required: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
});
export type MuseElicitationCreateParams = typeof MuseElicitationCreateParams.Type;

/** Fail-closed reply: the bridge treats anything but `accept` as cancelled. */
export const MUSE_ELICITATION_CANCEL_RESPONSE = { action: "cancel" } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function elicitationEnumValues(property: Record<string, unknown>): ReadonlyArray<string> {
  const own = Array.isArray(property.enum) ? property.enum : [];
  const items =
    isRecord(property.items) && Array.isArray(property.items.enum) ? property.items.enum : [];
  const candidates = own.length > 0 ? own : items;
  const seen = new Set<string>();
  const values: string[] = [];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate.trim() || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    // Display labels are returned verbatim: the bridge maps them back to the
    // original option label by position, so they must not be rewritten.
    values.push(candidate);
  }
  return values;
}

/**
 * The bridge serializes `requestedSchema.properties` with sorted keys
 * (serde `BTreeMap`), which scrambles `q{i}` question order once a form has
 * ten or more fields (q10 lands before q2). Sort qN keys numerically so they
 * re-align with the `message` lines, which follow question order.
 */
function orderedElicitationKeys(keys: ReadonlyArray<string>): ReadonlyArray<string> {
  const numeric = (key: string): number | undefined => {
    const match = /^q(\d+)$/.exec(key);
    return match ? Number(match[1]) : undefined;
  };
  if (keys.length > 0 && keys.every((key) => numeric(key) !== undefined)) {
    return [...keys].sort((a, b) => numeric(a)! - numeric(b)!);
  }
  return keys;
}

function humanizeElicitationKey(key: string, index: number): string {
  const numbered = /^q(\d+)$/.exec(key);
  if (numbered) {
    return `Question ${Number(numbered[1]) + 1}`;
  }
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  if (!spaced) {
    return `Question ${index + 1}`;
  }
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function splitElicitationLine(
  line: string | undefined,
): { readonly header?: string; readonly text: string } | undefined {
  const trimmed = line?.trim();
  if (!trimmed) {
    return undefined;
  }
  const separator = trimmed.indexOf(": ");
  if (separator <= 0) {
    return { text: trimmed };
  }
  const header = trimmed.slice(0, separator).trim();
  const text = trimmed.slice(separator + 2).trim();
  return text ? (header ? { header, text } : { text }) : { text: trimmed };
}

/**
 * Converts an `elicitation/create` form into T3 user-input questions.
 *
 * The bridge packs one `header: text` line per question into `message` and
 * one schema property per question (`q{i}` for user prompts, named fields
 * like `choice` for command pickers). Enum values become the option labels —
 * returned verbatim so the bridge can map them back by position. Every
 * question is `allowCustomAnswer: true`: free text is a first-class Muse
 * answer (it lands as `freeText` on the host side).
 */
export function museElicitationQuestions(input: {
  readonly message?: string | null | undefined;
  readonly requestedSchema?:
    | { readonly properties?: { readonly [x: string]: unknown } | null | undefined }
    | null
    | undefined;
}): ReadonlyArray<UserInputQuestion> {
  const properties = input.requestedSchema?.properties;
  if (!properties) {
    return [];
  }
  const keys = orderedElicitationKeys(Object.keys(properties));
  const message = isNonEmptyString(input.message) ? input.message : "";
  const lines = message.split("\n");
  return keys.flatMap((key, index) => {
    const property = isRecord(properties[key]) ? properties[key] : {};
    const parsed = splitElicitationLine(lines[index]);
    const header = parsed?.header ?? humanizeElicitationKey(key, index);
    const question =
      parsed?.text ?? (message.trim().length > 0 ? message.trim() : undefined) ?? header;
    if (!question.trim()) {
      return [];
    }
    const options = elicitationEnumValues(property).map((label) => ({
      label,
      description: label,
    }));
    const multiSelect = property.type === "array";
    return [
      {
        id: key,
        header: header.trim() || `Question ${index + 1}`,
        question,
        options,
        allowCustomAnswer: true,
        ...(multiSelect ? { multiSelect: true } : {}),
      } satisfies UserInputQuestion,
    ];
  });
}

/**
 * Maps T3 user-input answers back into the bridge's elicitation `content`
 * object, keyed by schema property name. Only strings and string arrays are
 * forwarded; `undefined` (nothing usable) must be answered with `cancel`,
 * never with an empty `accept`.
 */
export function museElicitationContent(
  questions: ReadonlyArray<UserInputQuestion>,
  answers: ProviderUserInputAnswers,
): Record<string, unknown> | undefined {
  const content: Record<string, unknown> = {};
  for (const question of questions) {
    const value = answers[question.id];
    if (typeof value === "string" && value.length > 0) {
      content[question.id] = value;
    } else if (Array.isArray(value)) {
      const labels = value.filter(
        (entry): entry is string => typeof entry === "string" && entry.length > 0,
      );
      if (labels.length > 0) {
        content[question.id] = labels;
      }
    }
  }
  return Object.keys(content).length > 0 ? content : undefined;
}
