function elementContainsMarkerOrVirtualRow(node: Node): boolean {
  if (!(node instanceof Element)) return false;
  return (
    node.matches(".find-match, .find-current, [data-linear-virtual-row]") ||
    node.querySelector(
      ".find-match, .find-current, [data-linear-virtual-row]",
    ) !== null
  );
}

export function mutationsAffectFindScrollbarGeometry(
  records: MutationRecord[],
  scrollContainer: HTMLElement | null,
  paper: HTMLElement | null,
): boolean {
  return records.some((record) => {
    if (
      record.target === document.documentElement ||
      record.target === scrollContainer ||
      record.target === paper
    ) {
      return true;
    }

    const target =
      record.target instanceof Element
        ? record.target
        : record.target.parentElement;
    if (!target || target.closest(".typewriter-cursor")) return false;

    if (record.type === "attributes") {
      return target.matches(
        ".find-match, .find-current, [data-linear-virtual-row]",
      );
    }
    if (record.type !== "childList") return false;

    return [...record.addedNodes, ...record.removedNodes].some(
      elementContainsMarkerOrVirtualRow,
    );
  });
}
