const WINDOWS_FORBIDDEN = /[<>:"/\\|?*]/g;
const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

/** Sanitize a title into a filesystem-safe slug (Japanese preserved). */
export function slugifyTitle(title: string): string {
  let slug = title.trim();
  if (!slug) slug = "untitled";
  slug = slug.replace(WINDOWS_FORBIDDEN, "_");
  slug = slug
    .split("")
    .map((ch) => (ch.charCodeAt(0) < 32 ? "_" : ch))
    .join("");
  slug = slug.replace(/[\s.]+$/g, "");
  if (WINDOWS_RESERVED.test(slug)) slug = `${slug}_`;
  if (!slug) slug = "untitled";
  return slug;
}

/** Resolve duplicate slugs within a directory by appending -2, -3, … */
export function resolveUniqueSlug(title: string, used: Set<string>): string {
  const base = slugifyTitle(title);
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let n = 2;
  while (used.has(`${base}-${n}`)) n += 1;
  const unique = `${base}-${n}`;
  used.add(unique);
  return unique;
}

/** Zero-pad a sort index for file prefixes (01, 02, …). */
export function padIndex(index: number, width = 2): string {
  return String(index).padStart(width, "0");
}
