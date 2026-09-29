import { play } from "cuelume";

// Robust clipboard write shared by every Copy button on the site.
// Returns true only when the text actually landed on the clipboard, so
// callers can flip a green state without lying. The success cue lives here,
// not in each caller, so every Copy button on the site sounds the same.
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      play("success", { volume: 0.4 });
      return true;
    } catch {
      // fall through to the textarea path
    }
  }
  // Clipboard API absent or rejected — fall back to a hidden textarea.
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  if (ok) play("success", { volume: 0.4 });
  return ok;
}
