/**
 * `/api/info`'s `site` field: the store's `site` block (`runner/src/site-settings.ts`)
 * as the dashboard takes it, with the about page's markdown rendered here,
 * server-side, to HTML the page can set as it is.
 *
 * The HTML is the one thing on `/api/info` a page puts into the document
 * unescaped, so what it may hold is decided here and nowhere else:
 *
 * - No raw HTML: `Bun.markdown` is run with HTML blocks and spans off, so a
 *   `<script>` or `<img onerror>` in the source is text on the page.
 * - No images: an image is its alt text. A picture is a request to whatever
 *   host the markdown names, which the public site makes to no one.
 * - Links only to `https:`, `http:`, `mailto:`, a path in the site (`/…`,
 *   never `//…`) or a fragment, judged on the attribute exactly as rendered;
 *   any other target (`javascript:`, `data:`, an entity-spelled scheme) is
 *   its text alone, not a link.
 *
 * The name, theme and home travel as the store validated them.
 */

import type { ApiSiteInfo } from "./api-types";
import type { SiteSettings } from "../runner/src/site-settings";

const MARKDOWN: Bun.markdown.Options = { noHtmlBlocks: true, noHtmlSpans: true, tagFilter: true };
const SAFE_HREF = /^(https?:\/\/|mailto:|\/(?![/\\])|#)/i;

/** The about page's markdown as HTML that carries nothing scriptable. Pure. */
export function renderAboutHtml(markdown: string): string {
  return Bun.markdown
    .html(markdown, MARKDOWN)
    .replace(/<img\b[^>]*>/g, (tag) => /\balt="([^"]*)"/.exec(tag)?.[1] ?? "")
    // A link cannot hold a link, so the first close after an opening tag is its own.
    .replace(/<a href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, (whole, href: string, text: string) => (SAFE_HREF.test(href) ? whole : text))
    // And any href the pass above did not see: text cannot spell one, since a quote in it is `&quot;`.
    .replace(/ href="([^"]*)"/g, (whole, href: string) => (SAFE_HREF.test(href) ? whole : ""));
}

/** The last rendering, by its source: every open tab polls `/api/info`, and the text changes on an edit. */
let memo: { source: string; html: string } | undefined;

function aboutHtmlOf(source: string): string {
  if (memo?.source !== source) memo = { source, html: renderAboutHtml(source) };
  return memo.html;
}

/** `/api/info`'s `site`, spread in: the field when the block sets any of these, nothing otherwise. */
export function siteInfoField(site: SiteSettings): { site?: ApiSiteInfo } {
  const out: ApiSiteInfo = {
    ...(site.name !== undefined ? { name: site.name } : {}),
    ...(site.theme !== undefined ? { theme: site.theme } : {}),
    ...(site.home !== undefined ? { home: site.home } : {}),
    ...(site.about !== undefined ? { aboutHtml: aboutHtmlOf(site.about) } : {}),
  };
  return Object.keys(out).length === 0 ? {} : { site: out };
}
