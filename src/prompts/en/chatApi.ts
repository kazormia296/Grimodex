export function buildSynopsisFromContentPromptEn(
  sceneTitle: string,
  sceneContent: string,
): string {
  return (
    `Write a concise synopsis of the following scene "${sceneTitle}" in 1-3 sentences (about 60-120 words) in English.\n` +
    `Output only the synopsis. No extra explanation is needed.\n\n` +
    `===Scene body===\n${sceneContent}`
  );
}

export function buildSessionTitlePromptEn(
  userMessage: string,
  assistantReply: string,
): string {
  return (
    `Give the following chat exchange a short title of 3-6 words in English.\n` +
    `Output only the title.\n\n` +
    `User: ${userMessage.slice(0, 500)}\n\n` +
    `AI: ${assistantReply.slice(0, 500)}`
  );
}
