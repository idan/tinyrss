/** Fixture feeds served from a local HTTP server. Dates are relative to now so retention never drops them. */
const ago = (hours: number) => new Date(Date.now() - hours * 3600_000);

export function rssFeed(count = 3) {
  const items = Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    return `<item>
      <title>RSS item ${n} &amp; more</title>
      <link>https://example.com/rss/${n}</link>
      <guid isPermaLink="false">rss-${n}</guid>
      <pubDate>${ago(n).toUTCString()}</pubDate>
      <dc:creator>Author ${n}</dc:creator>
      <description>&lt;p&gt;Summary ${n}&lt;/p&gt;</description>
      ${n === 1 ? `<content:encoded><![CDATA[<p>Full <b>content</b> 1</p>]]></content:encoded>` : ""}
      ${n === 2 ? `<enclosure url="https://example.com/ep2.mp3" type="audio/mpeg" length="1234"/>` : ""}
    </item>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Example RSS</title>
    <link>https://example.com/</link>
    <description>test</description>
    ${items.join("\n")}
  </channel>
</rss>`;
}

export function atomFeed() {
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title type="text">Example Atom</title>
  <link href="https://atom.example.org/" rel="alternate" type="text/html"/>
  <link href="https://atom.example.org/feed.xml" rel="self"/>
  <id>urn:uuid:feed</id>
  <updated>${ago(1).toISOString()}</updated>
  <author><name>Feed Author</name></author>
  <entry>
    <title>Atom &lt;b&gt;one&lt;/b&gt;</title>
    <link href="/posts/1"/>
    <id>urn:uuid:1</id>
    <published>${ago(3).toISOString()}</published>
    <updated>${ago(2).toISOString()}</updated>
    <content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>Hello &amp; <em>xhtml</em></p></div></content>
  </entry>
  <entry>
    <title>Atom two</title>
    <link rel="alternate" type="text/html" href="https://atom.example.org/posts/2"/>
    <link rel="enclosure" type="audio/mpeg" href="https://atom.example.org/2.mp3" length="99"/>
    <id>urn:uuid:2</id>
    <updated>${ago(1).toISOString()}</updated>
    <summary type="html">&lt;p&gt;escaped &amp;amp; html&lt;/p&gt;</summary>
  </entry>
  <entry>
    <title>Atom three</title>
    <id>urn:uuid:3</id>
    <updated>${ago(0.5).toISOString()}</updated>
    <content type="html"><![CDATA[<p>cdata <i>html</i></p>]]></content>
  </entry>
</feed>`;
}

export function jsonFeed() {
  return JSON.stringify({
    version: "https://jsonfeed.org/version/1.1",
    title: "Example JSON",
    home_page_url: "https://json.example.net/",
    items: [
      { id: "j1", url: "https://json.example.net/1", title: "JSON one", content_html: "<p>one</p>", date_published: ago(2).toISOString() },
      { id: 2, title: "JSON two", content_text: "two\nlines", date_published: ago(1).toISOString(), attachments: [{ url: "https://json.example.net/a.mp3", mime_type: "audio/mpeg" }] },
    ],
  });
}

export function rdfFeed() {
  return `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="https://rdf.example.com/">
    <title>Example RDF</title>
    <link>https://rdf.example.com/</link>
  </channel>
  <item rdf:about="https://rdf.example.com/1">
    <title>RDF one</title>
    <link>https://rdf.example.com/1</link>
    <description>first</description>
    <dc:date>${ago(1).toISOString()}</dc:date>
  </item>
</rdf:RDF>`;
}

export function startFixtureServer() {
  const state = { rssCount: 3, requests: 0 };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      state.requests++;
      const { pathname } = new URL(req.url);
      switch (pathname) {
        case "/rss.xml":
          return new Response(rssFeed(state.rssCount), { headers: { "content-type": "application/rss+xml" } });
        case "/atom.xml":
          return new Response(atomFeed(), { headers: { "content-type": "application/atom+xml", etag: '"v1"' } });
        case "/feed.json":
          return new Response(jsonFeed(), { headers: { "content-type": "application/feed+json" } });
        case "/rdf.xml":
          return new Response(rdfFeed(), { headers: { "content-type": "application/rdf+xml" } });
        case "/blog":
          return new Response(
            `<!doctype html><html><head><title>Blog</title>
             <link rel="alternate" type="application/atom+xml" title="Feed" href="/atom.xml">
             </head><body>hi</body></html>`,
            { headers: { "content-type": "text/html" } },
          );
        default:
          return new Response("not found", { status: 404 });
      }
    },
  });
  return { server, state, url: (p: string) => `http://127.0.0.1:${server.port}${p}` };
}
