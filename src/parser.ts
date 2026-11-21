import { XMLParser } from "fast-xml-parser";

export interface Enclosure {
  url: string;
  type?: string;
  length?: number;
}

export interface ParsedItem {
  guid: string;
  url?: string;
  title?: string;
  author?: string;
  /** HTML content */
  content?: string;
  /** unix seconds */
  published?: number;
  /** unix seconds */
  updated?: number;
  enclosures: Enclosure[];
}

export interface ParsedFeed {
  title?: string;
  siteUrl?: string;
  items: ParsedItem[];
}

export class NotAFeedError extends Error {
  constructor(message = "document is not an RSS, Atom or JSON feed") {
    super(message);
    this.name = "NotAFeedError";
  }
}

const ARRAY_TAGS = new Set(["item", "entry", "link", "enclosure", "author", "category", "outline"]);

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  htmlEntities: false,
  // Keep Atom content raw so type="xhtml" content isn't mangled into objects.
  stopNodes: ["feed.entry.content", "feed.entry.summary"],
  isArray: (name) => ARRAY_TAGS.has(name),
});

type Node = any;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  copy: "©",
  reg: "®",
  trade: "™",
  middot: "·",
  bull: "•",
};

/** Decode XML/HTML character references. Unknown named entities are left untouched. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    return NAMED_ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Decode only the five XML entities + numeric references (for raw XML text). */
function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gi, (m, e: string) => {
    if (e[0] === "#") return decodeEntities(m);
    return NAMED_ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Decode raw XML text that may contain CDATA sections. */
function decodeRawXmlText(raw: string): string {
  let out = "";
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
  let last = 0;
  for (let m = re.exec(raw); m; m = re.exec(raw)) {
    out += decodeXml(raw.slice(last, m.index)) + m[1];
    last = m.index + m[0].length;
  }
  return out + decodeXml(raw.slice(last));
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function textToHtml(s: string): string {
  return escapeHtml(s).replace(/\r?\n/g, "<br>");
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, "");
}

/** Normalize a title: plain text, decoded, whitespace collapsed. */
function cleanTitle(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const t = decodeEntities(stripTags(s)).replace(/\s+/g, " ").trim();
  return t || undefined;
}

function first<T>(v: T | T[] | undefined): T | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function text(node: Node): string | undefined {
  node = first(node);
  if (node === undefined || node === null) return undefined;
  if (typeof node === "string") return node;
  if (typeof node === "number" || typeof node === "boolean") return String(node);
  if (typeof node === "object" && "#text" in node) return String(node["#text"]);
  return undefined;
}

function parseDate(s: string | undefined): number | undefined {
  if (!s) return undefined;
  let t = Date.parse(s.trim());
  if (Number.isNaN(t)) {
    // Some feeds use non-standard timezone names, e.g. "Mon, 01 Jan 2024 10:00:00 CEST".
    t = Date.parse(s.trim().replace(/\s+[A-Z]{3,5}$/, " GMT"));
  }
  return Number.isNaN(t) ? undefined : Math.floor(t / 1000);
}

function resolveUrl(u: string | undefined, base: string | undefined): string | undefined {
  if (!u) return undefined;
  u = u.trim();
  try {
    return new URL(u, base).toString();
  } catch {
    return u || undefined;
  }
}

function toNumber(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function fallbackGuid(item: Omit<ParsedItem, "guid">): string {
  const basis = [item.url, item.title, item.published, item.content?.slice(0, 2000)].join("\u0000");
  return "hash:" + new Bun.CryptoHasher("sha1").update(basis).digest("hex");
}

/** Parse an RSS 0.9x/1.0/2.0, Atom or JSON Feed document. */
export function parseFeed(body: string, feedUrl?: string): ParsedFeed {
  const trimmed = body.trimStart().replace(/^\uFEFF/, "");
  if (trimmed.startsWith("{")) return parseJsonFeed(trimmed, feedUrl);

  let doc: Node;
  try {
    doc = xml.parse(trimmed);
  } catch (e) {
    throw new NotAFeedError(`invalid XML: ${(e as Error).message}`);
  }
  if (doc.rss) return parseRss(doc.rss.channel ? first(doc.rss.channel) : doc.rss, feedUrl);
  if (doc.feed) return parseAtom(doc.feed, feedUrl);
  const rdf = doc["rdf:RDF"] ?? doc.RDF;
  if (rdf) return parseRss({ ...(first(rdf.channel) ?? {}), item: rdf.item }, feedUrl);
  throw new NotAFeedError();
}

function parseRss(channel: Node, feedUrl?: string): ParsedFeed {
  const siteUrl = resolveUrl(
    (channel.link as Node[] | undefined)?.map(text).find((l) => l && /^https?:/i.test(l)) ?? text(channel.link),
    feedUrl,
  );
  const items: ParsedItem[] = [];
  for (const it of (channel.item as Node[] | undefined) ?? []) {
    const url = resolveUrl(text(it.link) ?? text(it["feedburner:origLink"]), siteUrl ?? feedUrl);
    const content = text(it["content:encoded"]) ?? text(it.description) ?? text(it["media:group"]?.["media:description"]);
    const enclosures: Enclosure[] = [];
    for (const enc of (it.enclosure as Node[] | undefined) ?? []) {
      const u = resolveUrl(enc["@_url"], feedUrl);
      if (u) enclosures.push({ url: u, type: enc["@_type"], length: toNumber(enc["@_length"]) });
    }
    const guidNode = first(it.guid);
    const item: Omit<ParsedItem, "guid"> = {
      url,
      title: cleanTitle(text(it.title)),
      author: cleanTitle(text(it["dc:creator"]) ?? text(it.author)),
      content: content || undefined,
      published: parseDate(text(it.pubDate) ?? text(it["dc:date"]) ?? text(it.published)),
      updated: parseDate(text(it["atom:updated"]) ?? text(it["dc:modified"])),
      enclosures,
    };
    const guid = text(guidNode) || it["@_rdf:about"] || url || fallbackGuid(item);
    items.push({ guid, ...item });
  }
  return { title: cleanTitle(text(channel.title)), siteUrl, items };
}

function atomLinks(node: Node): { href: string; rel: string; type?: string; length?: string }[] {
  return ((node.link as Node[] | undefined) ?? [])
    .filter((l) => l && typeof l === "object" && l["@_href"])
    .map((l) => ({ href: l["@_href"], rel: l["@_rel"] ?? "alternate", type: l["@_type"], length: l["@_length"] }));
}

function atomContent(node: Node): string | undefined {
  node = first(node);
  if (node === undefined) return undefined;
  const raw = typeof node === "string" ? node : String(node["#text"] ?? "");
  const type = typeof node === "object" ? (node["@_type"] ?? "text") : "text";
  if (type === "xhtml" || type === "application/xhtml+xml") return raw.trim() || undefined;
  const decoded = decodeRawXmlText(raw).trim();
  if (!decoded) return undefined;
  return type === "html" || type === "text/html" ? decoded : textToHtml(decoded);
}

function parseAtom(feed: Node, feedUrl?: string): ParsedFeed {
  const base = resolveUrl(feed["@_xml:base"], feedUrl) ?? feedUrl;
  const links = atomLinks(feed);
  const siteUrl = resolveUrl(
    (links.find((l) => l.rel === "alternate" && (!l.type || l.type.includes("html"))) ?? links.find((l) => l.rel === "alternate"))
      ?.href,
    base,
  );
  const feedAuthor = cleanTitle(text(first(feed.author)?.name));
  const items: ParsedItem[] = [];
  for (const e of (feed.entry as Node[] | undefined) ?? []) {
    const entryBase = resolveUrl(e["@_xml:base"], base) ?? base;
    const elinks = atomLinks(e);
    const alt = elinks.find((l) => l.rel === "alternate" && (!l.type || l.type.includes("html"))) ?? elinks.find((l) => l.rel === "alternate");
    const url = resolveUrl(alt?.href, entryBase);
    const enclosures = elinks
      .filter((l) => l.rel === "enclosure")
      .map((l) => ({ url: resolveUrl(l.href, entryBase)!, type: l.type, length: toNumber(l.length) }));
    const updated = parseDate(text(e.updated) ?? text(e.modified));
    const item: Omit<ParsedItem, "guid"> = {
      url,
      title: cleanTitle(text(e.title)),
      author: cleanTitle(text(first(e.author)?.name)) ?? feedAuthor,
      content: atomContent(e.content) ?? atomContent(e.summary) ?? text(e["media:group"]?.["media:description"]),
      published: parseDate(text(e.published) ?? text(e.issued)) ?? updated,
      updated,
      enclosures,
    };
    items.push({ guid: text(e.id) || url || fallbackGuid(item), ...item });
  }
  return { title: cleanTitle(text(feed.title)), siteUrl, items };
}

function parseJsonFeed(body: string, feedUrl?: string): ParsedFeed {
  let doc: Node;
  try {
    doc = JSON.parse(body);
  } catch {
    throw new NotAFeedError("invalid JSON");
  }
  if (typeof doc?.version !== "string" || !doc.version.includes("jsonfeed.org") || !Array.isArray(doc.items)) {
    throw new NotAFeedError();
  }
  const siteUrl = resolveUrl(doc.home_page_url, feedUrl);
  const feedAuthor = doc.authors?.[0]?.name ?? doc.author?.name;
  const items: ParsedItem[] = doc.items.map((it: Node) => {
    const url = resolveUrl(it.url ?? it.external_url, siteUrl ?? feedUrl);
    const item: Omit<ParsedItem, "guid"> = {
      url,
      title: cleanTitle(it.title),
      author: it.authors?.[0]?.name ?? it.author?.name ?? feedAuthor,
      content: it.content_html ?? (it.content_text ? textToHtml(it.content_text) : it.summary),
      published: parseDate(it.date_published) ?? parseDate(it.date_modified),
      updated: parseDate(it.date_modified),
      enclosures: (Array.isArray(it.attachments) ? it.attachments : [])
        .filter((a: Node) => a?.url)
        .map((a: Node) => ({ url: resolveUrl(a.url, feedUrl)!, type: a.mime_type, length: toNumber(a.size_in_bytes) })),
    };
    return { guid: it.id != null && it.id !== "" ? String(it.id) : url || fallbackGuid(item), ...item };
  });
  return { title: cleanTitle(doc.title), siteUrl, items };
}

/** Find feed URLs advertised in an HTML page via <link rel="alternate">. */
export function discoverFeedLinks(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const attr = (name: string) =>
      tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"))?.slice(1).find((x) => x !== undefined);
    const rel = attr("rel")?.toLowerCase().split(/\s+/) ?? [];
    const type = attr("type")?.toLowerCase() ?? "";
    const href = attr("href");
    if (!href || !rel.includes("alternate")) continue;
    if (!/(rss|atom|feed)\+(xml|json)|application\/(rss|atom)|application\/feed\+json|application\/json/.test(type)) continue;
    const u = resolveUrl(decodeEntities(href), baseUrl);
    if (u && !out.includes(u)) out.push(u);
  }
  return out;
}
