/**
 * Synthetic MediaWiki export fixtures.
 *
 * Everything here is invented. No text from any real wiki or game appears in
 * this repository, in fixtures or anywhere else.
 */

export interface FixtureRevision {
  id: number;
  timestamp: string;
  text: string;
}

export interface FixturePage {
  title: string;
  ns: number;
  id: number;
  revisions: FixtureRevision[];
  redirectAttr?: string;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function renderPage(page: FixturePage): string {
  const revs = page.revisions
    .map(
      (r) => `  <revision>
    <id>${r.id}</id>
    <parentid>${r.id - 1}</parentid>
    <timestamp>${r.timestamp}</timestamp>
    <contributor>
      <username>Example Editor</username>
      <id>4242</id>
    </contributor>
    <comment>example edit</comment>
    <text bytes="${r.text.length}" space="preserve">${esc(r.text)}</text>
    <sha1>0000000000000000000000000000000</sha1>
  </revision>`,
    )
    .join("\n");
  const redirect =
    page.redirectAttr !== undefined
      ? `\n  <redirect title="${esc(page.redirectAttr)}" />`
      : "";
  return `<page>
  <title>${esc(page.title)}</title>
  <ns>${page.ns}</ns>
  <id>${page.id}</id>${redirect}
${revs}
</page>`;
}

export function renderDump(pages: FixturePage[]): string {
  return `<mediawiki xmlns="http://www.mediawiki.org/xml/export-0.10/" version="0.10" xml:lang="en">
  <siteinfo>
    <sitename>Example Wiki</sitename>
    <namespaces>
      <namespace key="0" case="first-letter" />
      <namespace key="118" case="first-letter">Quest</namespace>
    </namespaces>
  </siteinfo>
${pages.map(renderPage).join("\n")}
</mediawiki>
`;
}
