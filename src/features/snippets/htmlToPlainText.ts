export function htmlToPlainText(html: string): string {
  if (!html) return "";
  if (typeof DOMParser === "undefined") {
    return html.replace(/<[^>]*>/g, "");
  }
  const doc = new DOMParser().parseFromString(html, "text/html");
  return (doc.body.textContent ?? "").replace(/\s+/g, " ").trim();
}
