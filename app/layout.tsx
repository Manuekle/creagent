import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { Habibi, Silkscreen } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import { InlineScript } from "@/components/InlineScript";
import { CommandPalette } from "@/components/CommandPalette";
import { SoundBind } from "@/components/SoundBind";
import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";
import { SITE_URL } from "@/lib/site";
import "./globals.css";

const serif = Habibi({
  variable: "--font-serif-stack",
  weight: ["400"],
  subsets: ["latin"],
});

// A real bitmap face for the label role — the site is pixel-art throughout and
// `.font-pixel` used to be Geist Mono in disguise. Silkscreen is drawn on an
// 8px grid, so it stays crisp at the 10-11px the labels actually render at.
const pixel = Silkscreen({
  variable: "--font-pixel-stack",
  weight: ["400", "700"],
  subsets: ["latin"],
});

const TITLE = "creagent — build AI agents, ship your skills";
const DESCRIPTION =
  "Craft AI agents with scraped skills for Claude Code, Codex & more. Pixel-native, MCP-ready.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: TITLE, template: "%s · creagent" },
  description: DESCRIPTION,
  alternates: { canonical: "/" },
  // app/icon.png, app/opengraph-image.png, app/twitter-image.png are auto-detected
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    siteName: "creagent",
    type: "website",
    url: "/",
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
  },
};

// Tints the mobile browser chrome to match whichever theme is showing, so the
// status bar doesn't sit on a colour the page never uses.
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f5f0" },
    { media: "(prefers-color-scheme: dark)", color: "#17150f" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      data-theme="light"
      suppressHydrationWarning
      className={`${GeistSans.variable} ${GeistMono.variable} ${serif.variable} ${pixel.variable} h-full antialiased`}
    >
      <head>
        <InlineScript
          html={`(function(){try{var t=localStorage.getItem("theme");if(!t)t=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";document.documentElement.setAttribute("data-theme",t)}catch(e){}})()`}
        />
      </head>
      <body className="min-h-full bg-paper text-ink flex flex-col">
        {/* First focusable thing on the page: six tabs plus the search, stars
            and account controls sit between the top of the document and the
            content on every route, and tabbing through them each time is the
            whole reason this link exists. */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:px-3 focus:py-2 focus:border-2 focus:border-line focus:bg-paper focus:font-mono focus:text-xs"
        >
          Skip to content
        </a>
        {/* The shell lives here, not in the pages. Rendered per page it was
            remounted on every navigation, which refetched the session and the
            star count and replayed the counter animation each time — and threw
            away the nav's own state (the open mobile drawer) with it. */}
        <Nav />
        {/* flex-1 so the footer sits at the bottom of the viewport on the
            short routes (privacy, terms, login) instead of halfway up it. */}
        <main id="main" className="flex-1">
          {children}
        </main>
        <Footer />
        {/* Global so ⌘K reaches every route, including the ones with no
            SkillBrowser on them. Renders nothing until opened. */}
        <CommandPalette />
        {/* Wires data-cuelume-* listeners once for the whole document. */}
        <SoundBind />
        {/* Last child of body so it never delays first paint. Injects nothing
            outside Vercel, so local dev and any other host stay untouched. */}
        <Analytics />
      </body>
    </html>
  );
}
