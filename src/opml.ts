import { XMLParser } from "fast-xml-parser";
import type { DB } from "./db.ts";
import { escapeHtml } from "./parser.ts";
import { addFeed, feedDisplayTitle, listFeeds } from "./store.ts";

export interface OpmlFeed {
  url: string;
  title?: string;
  folder?: string;
  siteUrl?: string;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseAttributeValue: false,
  parseTagValue: false,
  htmlEntities: true,
  isArray: (name) => name === "outline",
});

export function parseOpml(xml: string): OpmlFeed[] {
  const doc = parser.parse(xml);
  const body = doc?.opml?.body;
  if (!body) throw new Error("not an OPML document");
  const out: OpmlFeed[] = [];
  const walk = (outlines: any[] | undefined, folder: string | undefined) => {
    for (const o of outlines ?? []) {
      const url = o.xmlUrl ?? o.xmlurl;
      const label: string | undefined = (o.title ?? o.text)?.toString().trim() || undefined;
      if (url) {
        // Some exporters use the `category` attribute ("/Folder" or "Folder,Other").
        const cat = typeof o.category === "string" ? o.category.split(",")[0]?.replace(/^\//, "").trim() : undefined;
        out.push({ url: String(url).trim(), title: label, folder: folder ?? (cat || undefined), siteUrl: o.htmlUrl });
      }
      if (o.outline) walk(o.outline, url ? folder : (label ?? folder));
    }
  };
  walk(body.outline, undefined);
  return out;
}

export function importOpml(db: DB, xml: string): { added: number; skipped: number; errors: string[] } {
  const feeds = parseOpml(xml);
  let added = 0;
  let skipped = 0;
  const errors: string[] = [];
  db.transaction(() => {
    for (const f of feeds) {
      try {
        const { created } = addFeed(db, { url: f.url, feedTitle: f.title, tag: f.folder });
        if (created) added++;
        else skipped++;
      } catch (e) {
        errors.push(`${f.url}: ${(e as Error).message}`);
      }
    }
  })();
  return { added, skipped, errors };
}

const attr = (s: string) => escapeHtml(s);

export function exportOpml(db: DB): string {
  const feeds = listFeeds(db);
  const folders = new Map<string | null, typeof feeds>();
  for (const f of feeds) {
    const list = folders.get(f.tag_name) ?? [];
    list.push(f);
    folders.set(f.tag_name, list);
  }
  const outline = (f: (typeof feeds)[number], indent: string) => {
    const title = attr(feedDisplayTitle(f));
    const html = f.site_url ? ` htmlUrl="${attr(f.site_url)}"` : "";
    return `${indent}<outline type="rss" text="${title}" title="${title}" xmlUrl="${attr(f.url)}"${html}/>`;
  };
  const lines: string[] = [];
  for (const [folder, list] of folders) {
    if (folder === null) continue;
    lines.push(`    <outline text="${attr(folder)}" title="${attr(folder)}">`);
    for (const f of list) lines.push(outline(f, "      "));
    lines.push("    </outline>");
  }
  for (const f of folders.get(null) ?? []) lines.push(outline(f, "    "));
  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>tinyrss subscriptions</title>
    <dateCreated>${new Date().toUTCString()}</dateCreated>
  </head>
  <body>
${lines.join("\n")}
  </body>
</opml>
`;
}
