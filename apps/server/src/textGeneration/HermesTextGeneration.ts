import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";
import type * as EffectAcpErrors from "effect-acp/errors";

import { type HermesSettings, TextGenerationError } from "@t3tools/contracts";

import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import {
  applyHermesAcpModelSelection,
  currentHermesModelIdFromSessionSetup,
  makeHermesAcpRuntime,
  resolveHermesAcpBaseModelId,
} from "../provider/acp/HermesAcpSupport.ts";

const HERMES_TIMEOUT_MS = 180_000;

const isTextGenerationError = Schema.is(TextGenerationError);

export const makeHermesTextGeneration = Effect.fn("makeHermesTextGeneration")(function* (
  hermesSettings: HermesSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const crypto = yield* Crypto.Crypto;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const runHermesJson: TextGenerationOperations.Runner = (request) => {
    const { operation, cwd, prompt, modelSelection } = request;
    return Effect.gen(function* () {
      const resolvedModel = resolveHermesAcpBaseModelId(modelSelection.model);
      const outputRef = yield* Ref.make("");
      const runtime = yield* makeHermesAcpRuntime({
        hermesSettings,
        environment,
        childProcessSpawner: commandSpawner,
        cwd,
        clientInfo: { name: "t3-code-git-text", version: "0.0.0" },
      }).pipe(Effect.provideService(Crypto.Crypto, crypto));

      // Text generation is not interactive: a permission prompt would deadlock,
      // so every request is declined. Hermes still answers with plain text.
      yield* runtime.handleRequestPermission(() =>
        Effect.succeed({ outcome: { outcome: "cancelled" } }),
      );
      yield* runtime.handleSessionUpdate((notification) => {
        const update = notification.update;
        if (update.sessionUpdate !== "agent_message_chunk") {
          return Effect.void;
        }
        const content = update.content;
        if (content.type !== "text") {
          return Effect.void;
        }
        return Ref.update(outputRef, (current) => current + content.text);
      });

      const promptResult = yield* Effect.gen(function* () {
        const started = yield* runtime.start();
        yield* applyHermesAcpModelSelection({
          runtime,
          currentModelId: currentHermesModelIdFromSessionSetup(started.sessionSetupResult),
          requestedModelId: resolvedModel,
          mapError: (cause) =>
            new TextGenerationError({
              operation,
              detail: "Failed to set Hermes ACP base model for text generation.",
              cause,
            }),
        });
        return yield* runtime.prompt({
          prompt: [{ type: "text", text: prompt }],
        });
      }).pipe(
        Effect.timeoutOption(HERMES_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({ operation, detail: "Hermes ACP request timed out." }),
              ),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
        Effect.mapError((cause: EffectAcpErrors.AcpError | TextGenerationError) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation,
                detail: "Hermes ACP request failed.",
                cause,
              }),
        ),
      );

      const trimmed = (yield* Ref.get(outputRef)).trim();
      if (!trimmed) {
        return yield* new TextGenerationError({
          operation,
          detail:
            promptResult.stopReason === "cancelled"
              ? "Hermes ACP request was cancelled."
              : "Hermes Agent returned empty output.",
        });
      }

      return yield* TextGenerationOperations.decodeJsonReply(request, "Hermes Agent", trimmed);
    }).pipe(
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation,
              detail: "Hermes ACP text generation failed.",
              cause,
            }),
      ),
      Effect.scoped,
    );
  };

  return TextGenerationOperations.fromRunner("HermesTextGeneration", runHermesJson);
});
