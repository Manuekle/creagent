"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { play } from "cuelume";
import { clsx } from "@/lib/clsx";
import { copyText } from "@/lib/copy";
import { KIND_META, kindOfArg } from "@/lib/aitmpl";
import { PALETTE_OPEN_EVENT } from "@/lib/palette";
import { DEMO_PATH, requiresAccount } from "@/lib/access";
import { useSignedIn } from "@/lib/use-auth";
import type { Skill } from "@/lib/types";

// One search box over everything the app can reach: the pages, and both
// component registries. Mounted once in the root layout so ⌘K works from any
// route, including ones with no browser on them.

// Both variants render the same three slots: what it is called, what it is,
// and where it came from. Keeping the field names shared stops the row
// component from having to branch on `kind` just to lay itself out.
interface PageRow {
  kind: "page";
  id: string;
  label: string;
  detail: string; // what the page is for
  hint: string; // always "page"
  href: string;
}

interface ComponentRow {
  kind: "component";
  id: string;
  label: string;
  detail: string; // owner/repo or component id
  hint: string; // which registry
  command: string | null;
}

type Row = PageRow | ComponentRow;

function page(id: string, label: string, href: string, detail: string): PageRow {
  return { kind: "page", id, label, href, detail, hint: "page" };
}

const PAGES: PageRow[] = [
  page("p-home", "Home", "/", "landing"),
  page("p-demo", "Demo", DEMO_PATH, "watch an agent get built"),
  page("p-new", "New agent", "/new", "choose a starting point"),
  page("p-onboarding", "Onboarding", "/onboarding", "AI-assisted draft"),
  page("p-build", "Build", "/build", "the composer"),
  page("p-skills", "Skills", "/skills", "browse both registries"),
  page("p-mcp", "MCP server", "/mcp", "serve an agent over MCP"),
  page("p-pricing", "Pricing", "/pricing", "plans"),
];

/**
 * The page list as it stands for this visitor. Gated rows keep their place and
 * their name — dropping them would make ⌘K answer "no such page" for a page
 * that plainly exists — but they say what they need and go to the demo, the
 * same as the nav and the footer.
 */
function pagesFor(guest: boolean): PageRow[] {
  if (!guest) return PAGES;
  return PAGES.map((p) =>
    requiresAccount(p.href)
      ? {
          ...p,
          detail: `${p.detail} · needs an account`,
          href: `${DEMO_PATH}?from=${encodeURIComponent(p.href)}`,
        }
      : p,
  );
}

function matchPages(pages: PageRow[], q: string): PageRow[] {
  const needle = q.toLowerCase();
  if (!needle) return pages;
  return pages.filter(
    (p) => p.label.toLowerCase().includes(needle) || p.detail.toLowerCase().includes(needle),
  );
}

function installOf(s: Skill): string | null {
  const repo = s.repo ?? s.source;
  if (repo.includes("/")) return `npx skills add ${repo}`;
  if (s.installArg) return `npx claude-code-templates@latest ${s.installArg} --yes`;
  return null;
}

function toRow(s: Skill, kindLabel: string): ComponentRow {
  return {
    kind: "component",
    id: s.id,
    label: s.name,
    hint: kindLabel,
    detail: s.repo ?? s.slug,
    command: installOf(s),
  };
}

// Must match --modal-close-dur. The palette stays mounted for this long after
// close() so the exit transition has something to run on.
const CLOSE_MS = 150;

export function CommandPalette() {
  const router = useRouter();
  const guest = useSignedIn() === false;
  const [open, setOpen] = useState(false);
  // `open` means mounted; `shown` drives .is-open, and is flipped a frame
  // later so the browser has a starting state to transition from. `closing`
  // is the window between the exit starting and the unmount.
  const [shown, setShown] = useState(false);
  const [closing, setClosing] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Row[]>(PAGES);
  // The query `rows` was computed for. Typing is debounced, so between a
  // keystroke and its results the list on screen answers an older question —
  // and Enter on it would open whatever the previous query ranked first.
  const [rowsQuery, setRowsQuery] = useState("");
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  // Every search increments this; a response whose token is stale is dropped.
  // Without it a slow "re" can land after a fast "react" and replace it.
  const token = useRef(0);

  // ---- open / close -------------------------------------------------------

  // The ⌘K listener is bound once; this lets it read the live open state
  // without re-binding on every toggle.
  const openRef = useRef(false);
  openRef.current = open && !closing;

  // Cancels any exit in flight, so re-opening mid-close resumes rather than
  // fighting the timer that is about to unmount the panel.
  const openNow = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
      setClosing(false);
    }
    setOpen(true);
    play("bloom");
  }, []);

  const close = useCallback(() => {
    // Guard re-entry: Escape twice, or a backdrop click landing mid-exit,
    // would otherwise restart the timer and strand the overlay.
    if (closeTimer.current) return;
    setShown(false);
    setClosing(true);
    play("droplet");
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      setOpen(false);
      setClosing(false);
      // Reset only once it is gone — clearing the query while the panel is
      // still on screen flashes the page list during the exit.
      setQ("");
      setRows(PAGES);
      setRowsQuery("");
      setActive(0);
    }, CLOSE_MS);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (openRef.current) close();
        else openNow();
      }
    };
    document.addEventListener("keydown", onKey);
    window.addEventListener(PALETTE_OPEN_EVENT, openNow);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener(PALETTE_OPEN_EVENT, openNow);
    };
  }, [close, openNow]);

  // Enter: mount at scale(--modal-scale)/opacity 0, then add .is-open on the
  // next frame. Flipping both in one paint gives the browser no start state
  // and the transition never runs.
  useEffect(() => {
    if (!open || closing) return;
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, [open, closing]);

  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (!open) return;

    // Remember who opened it, so focus can go back there on close. Without
    // this, Escape drops focus to <body> and a keyboard user restarts from
    // the top of the document.
    const opener = document.activeElement as HTMLElement | null;

    // Autofocus fires before the dialog paints on some browsers, so focus is
    // taken here instead.
    inputRef.current?.focus();
    inputRef.current?.select();

    // `aria-modal="true"` promises the rest of the page does not exist while
    // this is open. `inert` is what actually delivers it: without it, Tab
    // walks straight out of the panel into the nav behind, and assistive tech
    // has been told that content is not there.
    //
    // Matched by attribute rather than by "does it contain the overlay": the
    // toast below is a sibling of the overlay, not an ancestor, so it was
    // being inerted too — and an inert live region announces nothing, which is
    // the one thing that element exists to do.
    //
    // Next's route announcer is exempt for the same reason: it is a live region
    // whose whole job is to say the page changed, and choosing a page row here
    // navigates while this effect is still torn down — inerted, that navigation
    // is announced to nobody.
    const roots = [...document.body.children].filter(
      (el): el is HTMLElement =>
        el instanceof HTMLElement &&
        !el.hasAttribute("data-palette") &&
        el.tagName !== "NEXT-ROUTE-ANNOUNCER",
    );
    for (const el of roots) el.inert = true;

    // The page behind must not scroll while the overlay owns the viewport.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      for (const el of roots) el.inert = false;
      document.body.style.overflow = prevOverflow;
      // Only pull focus back if it is still loose in the overlay. Choosing a
      // page row navigates, and stealing focus back to the trigger afterwards
      // would fight the new route.
      if (!document.activeElement || document.activeElement === document.body) {
        opener?.focus?.();
      }
    };
  }, [open]);

  // Cycle Tab within the panel. `inert` already stops focus escaping into the
  // page, but without this the browser would park it on the URL bar instead of
  // returning to the top of the list.
  const trapTab = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const focusables = overlayRef.current?.querySelectorAll<HTMLElement>(
      'input, button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    );
    if (!focusables?.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  // ---- search -------------------------------------------------------------

  const search = useCallback(async (query: string) => {
    const mine = ++token.current;
    const pages = matchPages(pagesFor(guest), query);

    if (query.trim().length < 2) {
      setRows(pages);
      setRowsQuery(query);
      setActive(0);
      return;
    }

    setBusy(true);
    // Both registries at once: which one a component lives in is an install
    // detail, and nobody searching for "postgres" knows or cares up front.
    const [live, catalog] = await Promise.allSettled([
      fetch(`/api/skills?q=${encodeURIComponent(query)}`).then((r) => r.json()),
      fetch(
        `/api/skills?source=aitmpl&kind=all&q=${encodeURIComponent(query)}&sort=installs`,
      ).then((r) => r.json()),
    ]);
    if (mine !== token.current) return;

    const out: Row[] = [...pages];
    if (live.status === "fulfilled") {
      for (const s of (live.value.skills ?? []).slice(0, 6) as Skill[]) {
        out.push(toRow(s, "skills.sh"));
      }
    }
    if (catalog.status === "fulfilled") {
      for (const s of (catalog.value.skills ?? []).slice(0, 10) as Skill[]) {
        // Which feed a hit came from is the useful label here — "hooks" tells
        // you what you found in a way "aitmpl" does not.
        const meta = KIND_META.find((k) => k.id === kindOfArg(s.installArg));
        out.push(toRow(s, `aitmpl · ${meta?.label ?? "component"}`));
      }
    }

    setRows(out);
    setRowsQuery(query);
    setActive(0);
    setBusy(false);
  }, [guest]);

  // True while the visible list still answers an older query.
  const stale = rowsQuery !== q;

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => search(q), 220);
    return () => clearTimeout(t);
  }, [q, open, search]);

  // ---- activation ---------------------------------------------------------

  const choose = async (row: Row) => {
    if (row.kind === "page") {
      play("release");
      close();
      router.push(row.href);
      return;
    }
    if (!row.command) return;
    if (await copyText(row.command)) {
      setToast(`copied ${row.command}`);
      setTimeout(() => setToast(null), 1800);
      close();
    }
  };

  // Keeps the highlighted row in view when moving by keyboard past the fold.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({
      block: "nearest",
    });
  }, [active]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") return close();
    trapTab(e);
    if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
      e.preventDefault();
      setActive((i) => (rows.length ? (i + 1) % rows.length : 0));
    } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
      e.preventDefault();
      setActive((i) => (rows.length ? (i - 1 + rows.length) % rows.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      // Typing a query and hitting Enter before the debounce fires must not
      // open the previous query's top hit. Run the search now instead; the
      // second Enter, on results that match what is typed, does the opening.
      if (stale) {
        search(q);
        return;
      }
      const row = rows[active];
      if (row) choose(row);
    }
  };

  // The status region is mounted whether or not the palette is open and
  // whether or not it has anything to say. A region inserted at the same
  // moment its text appears announces unreliably across screen readers; a
  // stable one that gets written into does not.
  //
  // It carries two things. A toast, which is shown; and, while the palette is
  // open, the result count, which is not — arrowing through a list nobody
  // announced the size of gives no sense of how far there is to go, and a
  // search that quietly returns nothing is otherwise silent.
  const status = (
    <div
      role="status"
      aria-live="polite"
      data-palette=""
      className={clsx(
        "fixed bottom-4 left-1/2 -translate-x-1/2 z-50 font-mono text-[10px] px-3 py-2 border-2 border-line bg-paper",
        !toast && "sr-only",
      )}
    >
      {toast ??
        (open && !closing && !busy && !stale
          ? `${rows.length} result${rows.length === 1 ? "" : "s"}`
          : "")}
    </div>
  );

  if (!open) return status;

  return (
    <>
      {status}
      <div
        ref={overlayRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        data-palette=""
        className={clsx(
          "fixed inset-0 z-50 flex items-start justify-center pt-[12vh] px-4 overscroll-contain",
          "t-modal-backdrop",
          shown && "is-open",
          closing && "is-closing",
        )}
        onMouseDown={(e) => {
          // mousedown, not click: a drag that starts inside the panel and ends
          // on the backdrop would otherwise close it mid-selection.
          if (e.target === e.currentTarget) close();
        }}
      >
      <div
        className={clsx(
          "w-full max-w-xl border-2 border-line bg-paper t-modal",
          shown && "is-open",
          closing && "is-closing",
        )}
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-2 border-b-2 border-line px-3">
          <span className="font-mono text-[10px] text-muted shrink-0" aria-hidden="true">
            ›
          </span>
          {/* A combobox, not a bare text field. The arrow keys move a highlight
              that focus never follows — that is the right behaviour, and it is
              also why the highlight has to be announced some other way. Without
              `aria-activedescendant` a screen reader hears the typing and
              nothing else: ↑↓ moves a bar it is never told about, and Enter
              opens a row it never read out. The list below carries the matching
              listbox/option roles that make those ids mean something. */}
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search pages, skills, hooks, MCP servers…"
            aria-label="Search"
            role="combobox"
            aria-expanded={rows.length > 0}
            aria-controls={`${baseId}-list`}
            aria-activedescendant={rows[active] ? `${baseId}-row-${active}` : undefined}
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
            className="flex-1 bg-transparent py-3 font-mono text-xs outline-none placeholder:text-muted"
          />
          {(busy || stale) && (
            <span className="font-mono text-[10px] text-muted shrink-0" aria-hidden="true">
              …
            </span>
          )}
          <kbd className="font-mono text-[9px] text-muted border-2 border-line px-1.5 py-0.5 shrink-0">
            esc
          </kbd>
        </div>

        {/* Dimmed while the list answers an older query, so a row that is
            about to be replaced does not read as a settled result. */}
        <div
          ref={listRef}
          id={`${baseId}-list`}
          role="listbox"
          aria-label="Results"
          className={clsx("max-h-[52vh] overflow-auto transition-opacity", stale && "opacity-50")}
        >
          {rows.map((row, i) => (
            // A div, not a button: in a combobox the input keeps focus and
            // points at the active row, so options must not be separately
            // tabbable — as buttons they put every result into the tab order
            // and gave Tab two jobs at once. Same call ui.tsx's Select makes.
            <div
              key={row.id}
              id={`${baseId}-row-${i}`}
              role="option"
              aria-selected={i === active}
              aria-disabled={row.kind === "component" && !row.command}
              data-active={i === active}
              data-cuelume-hover="tick"
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(row)}
              className={clsx(
                "w-full text-left px-3 py-2 flex items-baseline gap-2 transition-colors cursor-pointer",
                row.kind === "component" && !row.command && "opacity-40 pointer-events-none",
                i === active ? "bg-fill text-on-fill" : "hover:bg-stone",
              )}
            >
              <span className="font-mono text-xs truncate">{row.label}</span>
              <span
                className={clsx(
                  "font-mono text-[10px] truncate",
                  i === active ? "text-on-fill-muted" : "text-coral-text",
                )}
              >
                {row.detail}
              </span>
              <span
                className={clsx(
                  "font-mono text-[9px] ml-auto shrink-0",
                  i === active ? "text-on-fill-muted" : "text-muted",
                )}
              >
                {row.hint}
              </span>
            </div>
          ))}
          {!busy && rows.length === 0 && (
            <p className="font-mono text-xs text-muted py-8 px-3 text-center">
              No matches for “{q}”. Try a shorter term.
            </p>
          )}
        </div>

        <div className="border-t-2 border-line px-3 py-1.5 flex gap-3 font-mono text-[9px] text-muted">
          <span>↑↓ move</span>
          <span>⏎ open / copy install</span>
        </div>
      </div>
      </div>
    </>
  );
}
