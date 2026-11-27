export function score(
  answer: string,
  expected: readonly string[],
  forbidden: readonly string[],
) {
  const forbiddenCount = forbidden.filter((fact) =>
    answer.includes(fact),
  ).length;
  return {
    correct: expected.some((fact) => answer.includes(fact)),
    forbiddenCount,
  };
}
