export function shouldAbortMastraTurn(input: {
  explicitlyAborted: boolean;
  isCurrentTurn: boolean;
  workspaceIsCurrent: boolean;
  projectIsCurrent: boolean;
  chatPolicyAllows: boolean;
  licenseAllows: boolean;
  quiescenceAllowsMutation: boolean;
}): boolean {
  return (
    input.explicitlyAborted ||
    !input.isCurrentTurn ||
    !input.workspaceIsCurrent ||
    !input.projectIsCurrent ||
    !input.chatPolicyAllows ||
    !input.licenseAllows ||
    !input.quiescenceAllowsMutation
  );
}
