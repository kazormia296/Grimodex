export function buildSynopsisFromContentPromptJa(
  sceneTitle: string,
  sceneContent: string,
): string {
  return (
    `以下のシーン「${sceneTitle}」の内容を1〜3文（100〜200文字程度）で簡潔にまとめたSynopsisを日本語で書いてください。\n` +
    `Synopsisのみを出力してください。余分な説明は不要です。\n\n` +
    `===シーン本文===\n${sceneContent}`
  );
}

export function buildSessionTitlePromptJa(
  userMessage: string,
  assistantReply: string,
): string {
  return (
    `以下のチャットのやり取りに、3〜6語の短いタイトルを付けてください。\n` +
    `タイトルのみを出力してください。\n\n` +
    `ユーザー: ${userMessage.slice(0, 500)}\n\n` +
    `AI: ${assistantReply.slice(0, 500)}`
  );
}
