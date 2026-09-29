"use client";

import { useEffect } from "react";
import { bind } from "cuelume";

// Wires every data-cuelume-* attribute in the DOM, including ones added
// later by client-side navigation — delegated listeners, so this only ever
// needs to run once at the root. Renders nothing.
export function SoundBind() {
  useEffect(() => {
    bind();
  }, []);
  return null;
}
