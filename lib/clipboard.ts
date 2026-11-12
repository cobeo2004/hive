/**
 * Copies text. `navigator.clipboard` exists only in a secure context, so a panel served over plain
 * http on a tailnet name falls back to a hidden textarea and the legacy copy command.
 */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard) return navigator.clipboard.writeText(text);
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  try {
    if (!document.execCommand("copy")) throw new Error("The browser refused to copy.");
  } finally {
    area.remove();
  }
}
