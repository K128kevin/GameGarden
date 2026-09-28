export type ItchSnapshot = {
  url: string;
  title?: string;
  description?: string;
  coverImage?: string;
  price?: string;
  rating?: { count?: number; average?: number };
  tags?: string[];
  views?: number;
  downloads?: number;
  purchases?: number;
};

export function normalizeItchUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.trim().match(/^https?:\/\/([\w-]+)\.itch\.io\/([\w-]+)/i);
  return m ? `https://${m[1].toLowerCase()}.itch.io/${m[2].toLowerCase()}` : null;
}

function meta(html: string, prop: string): string | undefined {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']*)["']`, "i");
  return html.match(re)?.[1];
}

/** Public page data, plus stats from the itch.io API when the user supplied an API key. */
export async function fetchItchSnapshot(url: string, apiKey?: string | null): Promise<ItchSnapshot> {
  const base = normalizeItchUrl(url) ?? url;
  const snap: ItchSnapshot = { url: base };

  const data = await fetch(`${base}/data.json`, { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  if (data) {
    snap.title = data.title;
    snap.coverImage = data.cover_image;
    snap.price = data.price;
    if (data.rating) snap.rating = { count: data.rating.count, average: data.rating.rating };
    if (Array.isArray(data.tags)) snap.tags = data.tags;
  }

  const html = await fetch(base, { cache: "no-store" })
    .then((r) => (r.ok ? r.text() : ""))
    .catch(() => "");
  if (html) {
    snap.title ??= meta(html, "og:title");
    snap.description = meta(html, "og:description") ?? meta(html, "description");
    snap.coverImage ??= meta(html, "og:image");
    const tagBlock = html.match(/<td>Tags<\/td>\s*<td>([\s\S]*?)<\/td>/i)?.[1];
    if (tagBlock && !snap.tags) snap.tags = [...tagBlock.matchAll(/>([^<]+)<\/a>/g)].map((m) => m[1].trim());
  }

  if (apiKey) {
    type MyGame = { url: string; views_count?: number; downloads_count?: number; purchases_count?: number };
    const mine = await fetch(`https://itch.io/api/1/${encodeURIComponent(apiKey)}/my-games`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    const g = (mine?.games as MyGame[] | undefined)?.find((x) => normalizeItchUrl(x.url) === normalizeItchUrl(base));
    if (g) {
      snap.views = g.views_count;
      snap.downloads = g.downloads_count;
      snap.purchases = g.purchases_count;
    }
  }
  return snap;
}
