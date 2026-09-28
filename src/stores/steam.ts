export function parseSteamAppId(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(/store\.steampowered\.com\/app\/(\d+)/i) ?? url.match(/^(\d+)$/);
  return m ? m[1] : null;
}

export type SteamSnapshot = {
  appId: string;
  name?: string;
  shortDescription?: string;
  releaseDate?: string;
  comingSoon?: boolean;
  genres?: string[];
  tags?: string[];
  price?: string | null;
  headerImage?: string;
  totalReviews?: number;
  positiveReviews?: number;
  reviewScore?: string;
  recentReviews?: { text: string; votedUp: boolean; playtimeHours: number }[];
};

export async function fetchSteamSnapshot(appId: string): Promise<SteamSnapshot> {
  const snap: SteamSnapshot = { appId };
  const details = await fetch(`https://store.steampowered.com/api/appdetails?appids=${appId}&l=english`, { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  const d = details?.[appId]?.success ? details[appId].data : null;
  if (d) {
    snap.name = d.name;
    snap.shortDescription = d.short_description;
    snap.releaseDate = d.release_date?.date;
    snap.comingSoon = d.release_date?.coming_soon;
    snap.genres = (d.genres ?? []).map((g: { description: string }) => g.description);
    snap.tags = (d.categories ?? []).map((c: { description: string }) => c.description).slice(0, 12);
    snap.price = d.is_free ? "Free" : (d.price_overview?.final_formatted ?? null);
    snap.headerImage = d.header_image;
  }
  const reviews = await fetch(
    `https://store.steampowered.com/appreviews/${appId}?json=1&language=all&purchase_type=all&num_per_page=5&filter=recent`,
    { cache: "no-store" },
  )
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  if (reviews?.query_summary) {
    snap.totalReviews = reviews.query_summary.total_reviews;
    snap.positiveReviews = reviews.query_summary.total_positive;
    snap.reviewScore = reviews.query_summary.review_score_desc;
    snap.recentReviews = (reviews.reviews ?? []).slice(0, 5).map((r: { review: string; voted_up: boolean; author?: { playtime_forever?: number } }) => ({
      text: String(r.review).slice(0, 400),
      votedUp: r.voted_up,
      playtimeHours: Math.round((r.author?.playtime_forever ?? 0) / 60),
    }));
  }
  return snap;
}
