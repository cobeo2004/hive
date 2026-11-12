/**
 * Copies text. `navigator.clipboard` exists only in a secure context, so a panel served over plain
 * http on a tailnet name falls back to a hidden textarea and the legacy copy command. The textarea
 * goes inside the open dialog, if any, so the dialog's focus trap does not take the selection away.
 */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard) {
    try {
      return await navigator.clipboard.writeText(text);
    } catch {
      // Permission denied or the page lost focus: the copy command may still work.
    }
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  (document.activeElement?.closest("[role=dialog]") ?? document.body).append(area);
  area.select();
  area.setSelectionRange(0, text.length);
  try {
    if (!document.execCommand("copy")) throw new Error("The browser refused to copy.");
  } finally {
    area.remove();
  }
}
