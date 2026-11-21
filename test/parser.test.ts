import { describe, expect, test } from "bun:test";
import { exportOpml, importOpml, parseOpml } from "../src/opml.ts";
import { discoverFeedLinks, NotAFeedError, parseFeed } from "../src/parser.ts";
import { openDb } from "../src/db.ts";
import { listFeeds } from "../src/store.ts";
import { atomFeed, jsonFeed, rdfFeed, rssFeed } from "./fixtures.ts";

describe("parseFeed", () => {
  test("RSS 2.0", () => {
    const f = parseFeed(rssFeed(3), "https://example.com/rss.xml");
    expect(f.title).toBe("Example RSS");
    expect(f.siteUrl).toBe("https://example.com/");
    expect(f.items).toHaveLength(3);
    const [one, two] = f.items;
    expect(one!.guid).toBe("rss-1");
    expect(one!.title).toBe("RSS item 1 & more");
    expect(one!.content).toBe("<p>Full <b>content</b> 1</p>");
    expect(one!.author).toBe("Author 1");
    expect(two!.content).toBe("<p>Summary 2</p>");
    expect(two!.enclosures).toEqual([{ url: "https://example.com/ep2.mp3", type: "audio/mpeg", length: 1234 }]);
    expect(one!.published).toBeGreaterThan(Date.now() / 1000 - 7200);
  });

  test("Atom", () => {
    const f = parseFeed(atomFeed(), "https://atom.example.org/feed.xml");
    expect(f.title).toBe("Example Atom");
    expect(f.siteUrl).toBe("https://atom.example.org/");
    const [one, two, three] = f.items;
    expect(one!.title).toBe("Atom one");
    expect(one!.url).toBe("https://atom.example.org/posts/1");
    expect(one!.content).toContain("<p>Hello &amp; <em>xhtml</em></p>");
    expect(one!.author).toBe("Feed Author");
    expect(two!.content).toBe("<p>escaped &amp; html</p>");
    expect(two!.enclosures[0]).toEqual({ url: "https://atom.example.org/2.mp3", type: "audio/mpeg", length: 99 });
    expect(two!.published).toBe(two!.updated!);
    expect(three!.content).toBe("<p>cdata <i>html</i></p>");
    expect(three!.url).toBeUndefined();
    expect(three!.guid).toBe("urn:uuid:3");
  });

  test("JSON Feed", () => {
    const f = parseFeed(jsonFeed(), "https://json.example.net/feed.json");
    expect(f.title).toBe("Example JSON");
    expect(f.items[1]!.guid).toBe("2");
    expect(f.items[1]!.content).toBe("two<br>lines");
    expect(f.items[1]!.enclosures[0]!.url).toBe("https://json.example.net/a.mp3");
  });

  test("RSS 1.0 (RDF)", () => {
    const f = parseFeed(rdfFeed());
    expect(f.title).toBe("Example RDF");
    expect(f.items).toHaveLength(1);
    expect(f.items[0]!.guid).toBe("https://rdf.example.com/1");
    expect(f.items[0]!.content).toBe("first");
  });

  test("rejects HTML", () => {
    expect(() => parseFeed("<!doctype html><html><body>hi</body></html>")).toThrow(NotAFeedError);
  });

  test("items without guid or link get a stable hash guid", () => {
    const xml = `<rss><channel><title>x</title><item><title>t</title><description>d</description></item></channel></rss>`;
    const a = parseFeed(xml).items[0]!.guid;
    expect(a).toStartWith("hash:");
    expect(parseFeed(xml).items[0]!.guid).toBe(a);
  });

  test("discoverFeedLinks", () => {
    const links = discoverFeedLinks(
      `<link rel="stylesheet" href="/a.css"><link rel="alternate" type="application/rss+xml" href="/feed?a=1&amp;b=2">
       <LINK REL='alternate' TYPE='application/atom+xml' HREF='https://other.example/atom'>`,
      "https://site.example/blog/",
    );
    expect(links).toEqual(["https://site.example/feed?a=1&b=2", "https://other.example/atom"]);
  });
});

describe("OPML", () => {
  const opml = `<?xml version="1.0"?>
<opml version="1.0"><head><title>x</title></head><body>
  <outline text="Tech" title="Tech">
    <outline type="rss" text="A &amp; B" xmlUrl="https://a.example/feed"/>
    <outline text="Nested"><outline type="rss" text="C" xmlUrl="https://c.example/feed"/></outline>
  </outline>
  <outline type="rss" text="Loose" xmlUrl="https://loose.example/rss" htmlUrl="https://loose.example/"/>
</body></opml>`;

  test("parse", () => {
    expect(parseOpml(opml)).toEqual([
      { url: "https://a.example/feed", title: "A & B", folder: "Tech", siteUrl: undefined },
      { url: "https://c.example/feed", title: "C", folder: "Nested", siteUrl: undefined },
      { url: "https://loose.example/rss", title: "Loose", folder: undefined, siteUrl: "https://loose.example/" },
    ]);
  });

  test("import / export round trip", () => {
    const db = openDb(":memory:");
    expect(importOpml(db, opml)).toEqual({ added: 3, skipped: 0, errors: [] });
    expect(importOpml(db, opml).skipped).toBe(3);
    const exported = exportOpml(db);
    const db2 = openDb(":memory:");
    importOpml(db2, exported);
    expect(listFeeds(db2).map((f) => [f.url, f.tag_name])).toEqual(listFeeds(db).map((f) => [f.url, f.tag_name]));
  });
});
