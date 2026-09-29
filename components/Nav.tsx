"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { clsx } from "@/lib/clsx";
import { GitHubStars } from "@/components/GitHubStars";
import { ThemeToggle } from "@/components/ThemeToggle";
import { MenuIcon, CloseIcon, LockIcon } from "@/components/icons";
import { AuthButton } from "@/components/AuthButton";
import { openCommandPalette } from "@/lib/palette";
import { DEMO_PATH, requiresAccount } from "@/lib/access";
import { useSignedIn } from "@/lib/use-auth";

// `match` lists the extra path prefixes that should light the tab — the
// onboarding wizard is part of the New flow, so it must not leave the nav
// with nothing highlighted.
const LINKS: { href: string; label: string; match?: string[] }[] = [
  { href: "/", label: "Home" },
  { href: "/new", label: "New", match: ["/onboarding"] },
  { href: "/build", label: "Build" },
  { href: "/skills", label: "Skills" },
  { href: "/mcp", label: "MCP" },
  { href: "/pricing", label: "Pricing" },
];

function isActive(path: string, link: (typeof LINKS)[number]): boolean {
  if (link.href === "/") return path === "/";
  if (path.startsWith(link.href)) return true;
  return link.match?.some((m) => path.startsWith(m)) ?? false;
}

/**
 * Where a tab actually goes for this visitor. Signed out, the gated ones lead
 * to the demo carrying where they were headed, so the proxy's redirect is
 * something the nav told them about rather than a bounce that reads as a
 * broken link.
 *
 * The tab set itself never changes: dropping three of six tabs once auth
 * resolves would reflow the bar on every page load.
 */
function hrefFor(link: (typeof LINKS)[number], locked: boolean): string {
  return locked ? `${DEMO_PATH}?from=${encodeURIComponent(link.href)}` : link.href;
}

export function Nav() {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const signedIn = useSignedIn();
  // `null` is "not known yet" and must not read as "locked": showing a padlock
  // on every tab for a frame on each load is worse than showing none.
  const lockedFor = (href: string) => signedIn === false && requiresAccount(href);

  // Navigating with the drawer open would otherwise leave it hanging over the
  // page it just moved to.
  useEffect(() => setOpen(false), [path]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <header className="sticky top-0 z-40 border-b-2 border-line bg-paper/95 backdrop-blur">
      <div className="mx-auto max-w-6xl px-5 h-14 flex items-center justify-between">
        <Link href="/" className="group flex items-center gap-2">
          {/* The mark is pixel art, so it scales with nearest-neighbour rather
              than being resampled into mush. */}
          <img
            src="/logo-mark.png"
            alt=""
            width={28}
            height={28}
            className="pixelated shrink-0"
          />
          {/* Habibi wordmark as live text — scales at any DPI and inherits the
              theme colour, which a rasterised logo could not. */}
          <span className="font-serif text-2xl leading-none lowercase group-hover:text-coral transition-colors">
            creagent
          </span>
        </Link>

        <div className="flex items-center gap-2">
          {/* Six tabs plus the stars pill, the account control and the theme
              toggle need ~840px. The cutover used to be `sm` (640px), which
              overflowed the row on every narrow laptop once signed in — the
              whole set moves into the drawer below `lg` instead. */}
          <nav aria-label="Site" className="hidden lg:flex items-center gap-1">
            {LINKS.map((l) => {
              const locked = lockedFor(l.href);
              return (
                <Link
                  key={l.href}
                  href={hrefFor(l, locked)}
                  title={locked ? `${l.label} needs an account — see the demo` : undefined}
                  data-cuelume-hover="tick"
                  className={clsx(
                    "font-mono text-xs px-2 sm:px-3 py-1.5 border-2 transition-colors inline-flex items-center gap-1",
                    isActive(path, l)
                      ? "border-line bg-fill text-on-fill"
                      : "border-transparent hover:border-line hover:bg-stone",
                  )}
                >
                  {l.label}
                  {/* Decorative: the title above carries the same thing for
                      anyone who cannot see the glyph. */}
                  {locked && <LockIcon size={10} className="text-muted" aria-hidden="true" />}
                </Link>
              );
            })}
          </nav>

          {/* Visibility lives on the wrapper, not on GitHubStars' own className:
              the pill's base classes already set `inline-flex`, and Tailwind
              emits `hidden` earlier in the sheet, so a `hidden` passed through
              className would silently lose the cascade and the pill would
              overflow the bar on phones. */}
          {/* The shortcut works everywhere; this is the discoverable half of
              it. Hidden below `lg` for the same reason the tabs are — the row
              has no space for it, and a phone has no ⌘K to advertise. */}
          <button
            type="button"
            onClick={openCommandPalette}
            aria-label="Search (Command K)"
            className="hidden lg:inline-flex items-center gap-1.5 font-mono text-[10px] px-2 py-1.5 border-2 border-line bg-paper hover:bg-stone transition-colors cursor-pointer"
          >
            <span className="text-muted">Search</span>
            <kbd className="text-muted">⌘K</kbd>
          </button>

          <span className="hidden lg:inline-flex">
            <GitHubStars />
          </span>
          <span className="hidden lg:inline-flex">
            <AuthButton />
          </span>
          <ThemeToggle />

          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls="nav-drawer"
            aria-label={open ? "Close menu" : "Open menu"}
            className="lg:hidden grid place-items-center w-9 h-9 border-2 border-line bg-paper hover:bg-stone transition-colors cursor-pointer"
          >
            {/* Both icons occupy the same grid cell; only their opacity, blur
                and scale change, so the button never reflows mid-swap. */}
            <span className="t-icon-swap" data-state={open ? "b" : "a"}>
              <span className="t-icon" data-icon="a">
                <MenuIcon size={16} />
              </span>
              <span className="t-icon" data-icon="b">
                <CloseIcon size={16} />
              </span>
            </span>
          </button>
        </div>
      </div>

      {/* MOBILE DRAWER — the clip wrapper tweens height so the page below is
          pushed down in step with the panel instead of jumping.
          `inert` while closed, not just `tabIndex={-1}` on the links: the clip
          is `height: 0; overflow: hidden`, which hides the panel from sight but
          leaves everything inside it focusable. The two controls at the foot —
          the stars pill and the account button — carried no tabIndex guard, so
          tabbing the header on a phone dropped focus into a panel nobody could
          see. One attribute on the wrapper covers whatever ends up in here. */}
      <div id="nav-drawer" className="lg:hidden t-panel-clip" data-open={open} inert={!open}>
        <div className="t-panel-slide border-t-2 border-line" data-open={open}>
          <nav
            aria-label="Site (mobile)"
            className="mx-auto max-w-6xl px-5 py-3 flex flex-col gap-1"
          >
            {LINKS.map((l) => {
              const locked = lockedFor(l.href);
              return (
                <Link
                  key={l.href}
                  href={hrefFor(l, locked)}
                  className={clsx(
                    "font-mono text-xs px-3 py-2 border-2 transition-colors flex items-center gap-1.5",
                    isActive(path, l)
                      ? "border-line bg-fill text-on-fill"
                      : "border-transparent hover:border-line hover:bg-stone",
                  )}
                >
                  {l.label}
                  {locked && (
                    <>
                      <LockIcon size={10} className="text-muted" aria-hidden="true" />
                      <span className="ml-auto font-mono text-[10px] text-muted">
                        needs an account
                      </span>
                    </>
                  )}
                </Link>
              );
            })}
            <div className="pt-2 mt-1 border-t-2 border-line flex flex-wrap items-center gap-2">
              <GitHubStars />
              <AuthButton compact />
            </div>
          </nav>
        </div>
      </div>
    </header>
  );
}

