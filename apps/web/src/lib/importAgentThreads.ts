/**
 * Copy for anytime Claude Code / Codex history import. The RPC reports how
 * many conversations were newly materialized this call, not how many already
 * live in the project.
 */
export function describeAgentSessionImport(result: {
  readonly importedCount: number;
  readonly skippedCount: number;
}): {
  readonly type: "success" | "warning" | "error";
  readonly title: string;
  readonly description: string;
} {
  const { importedCount, skippedCount } = result;
  if (importedCount === 0 && skippedCount === 0) {
    return {
      type: "success",
      title: "No new threads found",
      description: "No new Claude Code or Codex conversations for this project.",
    };
  }
  if (importedCount > 0 && skippedCount === 0) {
    return {
      type: "success",
      title: importedCount === 1 ? "Imported 1 thread" : `Imported ${importedCount} threads`,
      description: "You can continue those conversations in this project.",
    };
  }
  if (importedCount > 0) {
    return {
      type: "warning",
      title: importedCount === 1 ? "Imported 1 thread" : `Imported ${importedCount} threads`,
      description:
        skippedCount === 1
          ? "1 thread could not be imported."
          : `${skippedCount} threads could not be imported.`,
    };
  }
  return {
    type: "error",
    title:
      skippedCount === 1
        ? "1 thread could not be imported"
        : `${skippedCount} threads could not be imported`,
    description: "Unreadable or unresumable sessions are skipped.",
  };
}
