import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useCallback, useRef } from "react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { describeAgentSessionImport } from "../lib/importAgentThreads";
import { agentSessionImport } from "../state/agentSessions";
import { useProjects } from "../state/entities";
import { useAtomCommand } from "../state/use-atom-command";

/**
 * Imports Claude Code and Codex conversations for one project via the existing
 * `agentSessions.import` RPC. Used from the command palette and thread menus so
 * those surfaces cannot drift.
 */
export function useImportAgentThreads() {
  const projects = useProjects();
  const importThreads = useAtomCommand(agentSessionImport, { reportFailure: false });
  const inFlightRef = useRef(false);

  const importForProject = useCallback(
    async (input: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId }) => {
      if (inFlightRef.current) return;
      const project = projects.find(
        (candidate) =>
          candidate.environmentId === input.environmentId && candidate.id === input.projectId,
      );
      if (project === undefined) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not import threads",
            description: "Open a project first.",
          }),
        );
        return;
      }

      inFlightRef.current = true;
      try {
        const result = await importThreads({
          environmentId: input.environmentId,
          input: {
            projectId: input.projectId,
            expectedWorkspaceRoot: project.workspaceRoot,
          },
        });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Could not import threads",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          }
          return;
        }
        toastManager.add(stackedThreadToast(describeAgentSessionImport(result.value)));
      } finally {
        inFlightRef.current = false;
      }
    },
    [importThreads, projects],
  );

  return { importForProject };
}
