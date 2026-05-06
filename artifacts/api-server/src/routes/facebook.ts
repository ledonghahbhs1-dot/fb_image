import { Router, type IRouter, type Request, type Response } from "express";
import { parse } from "node-html-parser";

const router: IRouter = Router();

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
  "Accept-Encoding": "gzip, deflate, br",
  "Cache-Control": "no-cache",
  "Pragma": "no-cache",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Upgrade-Insecure-Requests": "1",
};

// ─── Image extraction ──────────────────────────────────────────────────────

function extractFbcdnUrls(html: string): string[] {
  const seen = new Set<string>();
  const results: string[] = [];
  const patterns = [
    /(?:xlink:href|href)="(https:\/\/scontent[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/gi,
    /src="(https:\/\/scontent[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/gi,
    /"(https:\\\/\\\/scontent[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/gi,
    /(https:\/\/scontent[\w.\-/]+\.(?:jpg|jpeg|png|webp)(?:\?[^"'\s<>]*)?)/gi,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      let url = match[1].replace(/\\\//g, "/").replace(/&amp;/g, "&");
      if (!seen.has(url)) { seen.add(url); results.push(url); }
    }
  }
  return results;
}

function classifyUrl(url: string): "profile" | "post" | "thumbnail" | "other" {
  if (url.includes("_s40x40") || url.includes("_s50x50") || url.includes("_s32x32")) return "thumbnail";
  if (url.includes("cp0_dst-jpg_s") || url.includes("dst-jpg_s")) return "profile";
  if (url.includes("_n.jpg") || url.includes("_n.png")) return "post";
  return "other";
}

// ─── Relay User extraction ─────────────────────────────────────────────────

interface RelayUser {
  id: string;
  url: string | null;
  profile_url: string | null;
  short_name: string | null;
  name: string | null;
  gender: string | null;
  work_info: unknown;
  education_info: unknown;
  hometown: string | null;
  current_city: string | null;
  relationship_status: string | null;
  follower_count: number | null;
  friend_count: number | null;
  profile_picture: string | null;
  cover_photo: string | null;
  bio: string | null;
  verified: boolean | null;
}

function extractRelayUsers(html: string): RelayUser[] {
  const users = new Map<string, RelayUser>();

  // Match the specific Relay User pattern Facebook embeds
  const marker = /"__typename"\s*:\s*"User"\s*,\s*"__isEntity"\s*:\s*"User"\s*,\s*"__isActor"\s*:\s*"User"\s*,\s*"id"\s*:\s*"(\d+)"/g;

  let match: RegExpExecArray | null;
  while ((match = marker.exec(html)) !== null) {
    const id = match[1];
    if (users.has(id)) continue;

    // Grab a generous window of context around the match
    const winStart = Math.max(0, match.index - 50);
    const winEnd   = Math.min(html.length, match.index + 3000);
    const chunk    = html.slice(winStart, winEnd);

    // Helper: extract first regex match from chunk
    const pick = (re: RegExp) => { const m = chunk.match(re); return m?.[1] ?? null; };

    // Unescape Facebook's \/ encoding
    const unescape = (s: string | null) => s ? s.replace(/\\\//g, "/").replace(/\\u003C/g, "<").replace(/\\"/g, '"') : null;

    // Parse a nullable JSON field value (object or null)
    const parseNullable = (key: string): unknown => {
      const re = new RegExp(`"${key}"\\s*:\\s*(\\{[^{}]{0,800}\\}|null)`);
      const m = chunk.match(re);
      if (!m || m[1] === "null") return null;
      try { return JSON.parse(m[1].replace(/\\\//g, "/")); } catch { return m[1]; }
    };

    const rawName    = pick(/"name"\s*:\s*"([^"]{1,120})"/);
    const rawUrl     = pick(/"url"\s*:\s*"([^"]+)"/);
    const rawPUrl    = pick(/"profile_url"\s*:\s*"([^"]+)"/);
    const rawShort   = pick(/"short_name"\s*:\s*"([^"]{1,80})"/);
    const rawGender  = pick(/"gender"\s*:\s*"([^"]+)"/);
    const rawHt      = pick(/"hometown"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"/s);
    const rawCity    = pick(/"current_city"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"/s);
    const rawRel     = pick(/"relationship_status"\s*:\s*"([^"]+)"/);
    const rawFoll    = pick(/"follower_count"\s*:\s*(\d+)/);
    const rawFriend  = pick(/"friend_count"\s*:\s*(\d+)/);
    const rawPic     = pick(/"profile_picture_uri"\s*:\s*"([^"]+)"/);
    const rawCover   = pick(/"cover_photo"\s*:\s*\{[^}]*"photo"\s*:\s*\{[^}]*"image"\s*:\s*\{[^}]*"uri"\s*:\s*"([^"]+)"/s);
    const rawBio     = pick(/"biography"\s*:\s*\{[^}]*"text"\s*:\s*"([^"]+)"/s);
    const rawVerif   = pick(/"is_verified"\s*:\s*(true|false)/);

    users.set(id, {
      id,
      url:                 unescape(rawUrl),
      profile_url:         unescape(rawPUrl),
      short_name:          rawShort,
      name:                rawName,
      gender:              rawGender,
      work_info:           parseNullable("work_info"),
      education_info:      parseNullable("education_info"),
      hometown:            rawHt,
      current_city:        rawCity,
      relationship_status: rawRel,
      follower_count:      rawFoll ? Number(rawFoll) : null,
      friend_count:        rawFriend ? Number(rawFriend) : null,
      profile_picture:     unescape(rawPic),
      cover_photo:         unescape(rawCover),
      bio:                 rawBio,
      verified:            rawVerif ? rawVerif === "true" : null,
    });
  }

  return [...users.values()];
}

// ─── Deep extraction helpers ───────────────────────────────────────────────

function first(html: string, ...patterns: RegExp[]): string | null {
  for (const p of patterns) {
    const m = html.match(p);
    if (m?.[1]) return m[1].replace(/\\"/g, '"').replace(/\\u003C/g, "<").trim();
  }
  return null;
}

function all(html: string, pattern: RegExp): string[] {
  return [...new Set([...html.matchAll(pattern)].map(m => m[1]).filter(Boolean))];
}

function deepParse(html: string, pageUrl?: string) {
  const root = parse(html);

  // ── Meta tags ──
  const ogTitle    = root.querySelector('meta[property="og:title"]')?.getAttribute("content") ?? null;
  const ogDesc     = root.querySelector('meta[property="og:description"]')?.getAttribute("content") ?? null;
  const ogImage    = root.querySelector('meta[property="og:image"]')?.getAttribute("content") ?? null;
  const ogUrl      = root.querySelector('meta[property="og:url"]')?.getAttribute("content") ?? null;
  const ogType     = root.querySelector('meta[property="og:type"]')?.getAttribute("content") ?? null;
  const metaDesc   = root.querySelector('meta[name="description"]')?.getAttribute("content") ?? null;
  const canonical  = root.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? null;
  const title      = root.querySelector("title")?.text?.trim() ?? null;

  // ── Identity ──
  const uid = first(html,
    /"userID"\s*:\s*"(\d+)"/,
    /"USER_ID"\s*:\s*"(\d+)"/,
    /"entity_id"\s*:\s*"(\d+)"/,
    /"actorID"\s*:\s*"(\d+)"/,
    /"ownerID"\s*:\s*"(\d+)"/,
    /"profileID"\s*:\s*"(\d+)"/,
    /"pageID"\s*:\s*"(\d+)"/,
    /"id"\s*:\s*"(\d{8,})"/,
    /content_owner_id_new":(\d+)/,
    /"profile_id"\s*:\s*(\d+)/,
  );

  const username = first(html,
    /"username"\s*:\s*"([^"]+)"/,
    /"vanity"\s*:\s*"([^"]+)"/,
    /"profile_url_params".*?"alias"\s*:\s*"([^"]+)"/s,
  ) ?? (pageUrl ? pageUrl.split("facebook.com/")[1]?.split("?")[0]?.split("/")[0] : null);

  // ── Profile info ──
  const name = first(html,
    /"__typename"\s*:\s*"User"[^}]{0,200}"name"\s*:\s*"([A-Za-zÀ-ÿ0-9 .'-]{2,80})"/s,
    /"profile_name"\s*:\s*"([^"]{2,80})"/,
    /"title"\s*:\s*"([A-Za-zÀ-ÿ0-9 .'-]{2,80})"\s*,\s*"__typename"\s*:\s*"User"/s,
  ) ?? ogTitle;

  const gender = first(html,
    /"gender"\s*:\s*"([^"]+)"/,
    /gender['"]\s*:\s*['"]([^'"]+)['"]/i,
  );

  const birthday = first(html,
    /"birthday_reminder_info"[^}]*"date"\s*:\s*"([^"]+)"/s,
    /"birth_date"\s*:\s*"([^"]+)"/,
    /"birthdate"\s*:\s*\{[^}]*"text"\s*:\s*"([^"]+)"/s,
  );

  const createdTime = first(html,
    /"creation_time"\s*:\s*(\d+)/,
    /"account_created_time"\s*:\s*(\d+)/,
    /"join_time"\s*:\s*(\d+)/,
  );

  const relationshipStatus = first(html,
    /"relationship_status"\s*:\s*"([^"]+)"/,
    /"relationship_status_for_story_sharing"\s*:\s*"([^"]+)"/,
  );

  // ── Location ──
  const hometown = first(html,
    /"hometown"\s*:\{[^}]*"name"\s*:\s*"([^"]+)"/s,
    /"hometown_city"\s*:\{[^}]*"name"\s*:\s*"([^"]+)"/s,
  );
  const currentCity = first(html,
    /"current_city"\s*:\{[^}]*"name"\s*:\s*"([^"]+)"/s,
    /"current_address"\s*:\{[^}]*"city"\s*:\s*"([^"]+)"/s,
  );

  // ── Work & Education ──
  const workMatches   = all(html, /"employer"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"/gs);
  const schoolMatches = all(html, /"school"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"/gs);
  const positionMatches = all(html, /"position"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"/gs);

  // ── Stats ──
  const followerCount = first(html,
    /"follower_count"\s*:\s*(\d+)/,
    /"followers_count"\s*:\s*(\d+)/,
  );
  const friendCount = first(html,
    /"friend_count"\s*:\s*(\d+)/,
    /"friends_count"\s*:\s*(\d+)/,
    /"mutual_friends_count"\s*:\s*(\d+)/,
  );

  // ── Page / Group IDs ──
  const pageGroupIds = all(html, /"(?:page_id|group_id|pageID)"\s*:\s*"(\d+)"/g);

  // ── Email & Phone (sometimes exposed) ──
  const emails  = all(html, /["'\s]([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})["'\s]/g)
    .filter(e => !e.includes("facebook.com") && !e.includes("sentry.io") && !e.includes("example"));
  const phones  = all(html, /["'](\+?[0-9][0-9\s\-().]{7,}[0-9])["']/g)
    .filter(p => p.replace(/\D/g, "").length >= 9 && p.replace(/\D/g, "").length <= 15);

  // ── Security tokens ──
  const fbDtsg = first(html,
    /"DTSGInitData"\s*,\s*\[\]\s*,\s*\{"token"\s*:\s*"([^"]+)"/,
    /"fb_dtsg"\s*:\s*\{"value"\s*:\s*"([^"]+)"/,
    /name="fb_dtsg"\s+value="([^"]+)"/,
    /"fb_dtsg","([^"]+)"/,
  );
  const jazoest = first(html, /name="jazoest"\s+value="([^"]+)"/, /"jazoest"\s*:\s*"([^"]+)"/);
  const lsd     = first(html, /"LSD"\s*,\s*\[\]\s*,\s*\{"token"\s*:\s*"([^"]+)"/, /"lsd"\s*:\s*"([^"]+)"/);
  const spinT   = first(html, /"spin_t"\s*:\s*(\d+)/);
  const spinR   = first(html, /"spin_r"\s*:\s*(\d+)/);

  // ── Tracking & Ads ──
  const fbPixelIds  = all(html, /fbq\s*\(\s*['"]init['"]\s*,\s*['"](\d+)['"]/g);
  const adAccountId = first(html,
    /"ad_account_id"\s*:\s*"([^"]+)"/,
    /"adAccountID"\s*:\s*"([^"]+)"/,
  );
  const gaIds = all(html, /['"]?(UA-\d+-\d+|G-[A-Z0-9]+)['"]/g);

  // ── API endpoints found in source ──
  const apiEndpoints = all(html, /["'](\/api\/[a-zA-Z0-9_/\-.?=&]+)["']/g)
    .filter(e => e.length < 120)
    .slice(0, 20);

  const graphqlEndpoints = all(html, /["'](https?:\/\/[a-z]+\.facebook\.com\/api\/[^"'\s]+)["']/g).slice(0, 10);

  // ── Hidden JSON blobs from <script> tags ──
  const scriptTags = root.querySelectorAll("script");
  const jsonBlobs: Record<string, unknown>[] = [];
  for (const s of scriptTags) {
    const text = s.text;
    if (!text || text.length < 50) continue;
    // Try to find JSON-like objects with useful keys
    if (/(userID|entity_id|actorID|follower_count|profile_id|dtsg|token)/.test(text)) {
      const snippets = text.match(/\{[^{}]{30,500}\}/g) ?? [];
      for (const snippet of snippets.slice(0, 5)) {
        try {
          const parsed = JSON.parse(snippet) as Record<string, unknown>;
          if (Object.keys(parsed).length > 1) jsonBlobs.push(parsed);
        } catch { /* skip non-JSON */ }
      }
    }
  }

  // ── Relay Users (structured Relay JSON objects) ──
  const relayUsers = extractRelayUsers(html);

  // ── Images ──
  const imageUrls = extractFbcdnUrls(html);
  const images = imageUrls.map(u => ({ url: u, type: classifyUrl(u) }));
  if (ogImage && !images.find(i => i.url === ogImage)) {
    images.unshift({ url: ogImage, type: "profile" as const });
  }

  return {
    // ── Identity
    identity: {
      uid:      uid ?? null,
      username: username ?? null,
      name:     name ?? null,
      page_url: ogUrl ?? canonical ?? pageUrl ?? null,
      og_type:  ogType ?? null,
    },
    // ── Profile
    profile: {
      gender:              gender ?? null,
      birthday:            birthday ?? null,
      account_created_at:  createdTime ? new Date(Number(createdTime) * 1000).toISOString() : null,
      account_created_ts:  createdTime ? Number(createdTime) : null,
      relationship_status: relationshipStatus ?? null,
      hometown:            hometown ?? null,
      current_city:        currentCity ?? null,
      follower_count:      followerCount ? Number(followerCount) : null,
      friend_count:        friendCount   ? Number(friendCount)   : null,
      bio:                 ogDesc ?? metaDesc ?? null,
    },
    // ── Work & Education
    work_education: {
      employers: workMatches,
      positions: positionMatches,
      schools:   schoolMatches,
    },
    // ── IDs
    ids: {
      page_group_ids: pageGroupIds,
    },
    // ── Contact (if exposed)
    contact: {
      emails:        emails.slice(0, 5),
      phone_numbers: phones.slice(0, 5),
    },
    // ── Security tokens
    tokens: {
      fb_dtsg:  fbDtsg  ?? null,
      jazoest:  jazoest ?? null,
      lsd:      lsd     ?? null,
      spin_t:   spinT   ? Number(spinT) : null,
      spin_r:   spinR   ? Number(spinR) : null,
    },
    // ── Tracking
    tracking: {
      facebook_pixel_ids: fbPixelIds,
      ad_account_id:      adAccountId ?? null,
      google_analytics:   gaIds,
    },
    // ── API surface
    api_endpoints: {
      internal:  apiEndpoints,
      graphql:   graphqlEndpoints,
    },
    // ── Media
    images: {
      total:  images.length,
      avatar: ogImage ?? null,
      list:   images,
    },
    // ── Raw JSON snippets found in page
    json_snippets: jsonBlobs.slice(0, 10),
    // ── Relay User objects (structured __typename:User blocks)
    relay_users: relayUsers,
  };
}

// ─── Routes ───────────────────────────────────────────────────────────────

// Existing: scrape images only (kept for backward compat)
router.get("/facebook/scrape", async (req: Request, res: Response) => {
  const { url } = req.query as { url?: string };
  if (!url) { res.status(400).json({ error: "Missing ?url=", example: "/api/facebook/scrape?url=https://www.facebook.com/username" }); return; }
  if (!url.includes("facebook.com")) { res.status(400).json({ error: "URL must be facebook.com" }); return; }
  try {
    const response = await fetch(url, { headers: BROWSER_HEADERS, redirect: "follow" });
    if (!response.ok) { res.status(502).json({ error: `Facebook HTTP ${response.status}` }); return; }
    const html = await response.text();
    const images = extractFbcdnUrls(html).map(u => ({ url: u, type: classifyUrl(u) }));
    const root = parse(html);
    const ogImage = root.querySelector('meta[property="og:image"]')?.getAttribute("content") ?? null;
    const ogTitle = root.querySelector('meta[property="og:title"]')?.getAttribute("content") ?? null;
    if (ogImage && !images.find(i => i.url === ogImage)) images.unshift({ url: ogImage, type: "profile" });
    res.json({ page_url: url, page_title: ogTitle, total: images.length, images });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

// NEW: full deep extract via URL
router.get("/facebook/deep", async (req: Request, res: Response) => {
  const { url } = req.query as { url?: string };
  if (!url) { res.status(400).json({ error: "Missing ?url=", example: "/api/facebook/deep?url=https://www.facebook.com/username" }); return; }
  if (!url.includes("facebook.com")) { res.status(400).json({ error: "URL must be facebook.com" }); return; }
  try {
    const response = await fetch(url, { headers: BROWSER_HEADERS, redirect: "follow" });
    if (!response.ok) { res.status(502).json({ error: `Facebook HTTP ${response.status}`, hint: "Page may require login" }); return; }
    const html = await response.text();
    res.json(deepParse(html, url));
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

// NEW: full deep extract via pasted HTML
router.post("/facebook/deep/html", async (req: Request, res: Response) => {
  const { html, url } = req.body as { html?: string; url?: string };
  if (!html || typeof html !== "string") {
    res.status(400).json({ error: "Missing 'html' in body", usage: "POST body: { \"html\": \"<view-source paste>\", \"url\": \"optional original url\" }" });
    return;
  }
  res.json(deepParse(html, url));
});

// NEW: extract relay users only (fast, no image processing)
router.get("/facebook/relay-users", async (req: Request, res: Response) => {
  const { url } = req.query as { url?: string };
  if (!url) { res.status(400).json({ error: "Missing ?url=", example: "/api/facebook/relay-users?url=https://www.facebook.com/username" }); return; }
  if (!url.includes("facebook.com")) { res.status(400).json({ error: "URL must be facebook.com" }); return; }
  try {
    const response = await fetch(url, { headers: BROWSER_HEADERS, redirect: "follow" });
    if (!response.ok) { res.status(502).json({ error: `Facebook HTTP ${response.status}`, hint: "Page may require login" }); return; }
    const html = await response.text();
    const users = extractRelayUsers(html);
    res.json({ page_url: url, total: users.length, users });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

// NEW: extract relay users from pasted HTML
router.post("/facebook/relay-users/html", async (req: Request, res: Response) => {
  const { html, url } = req.body as { html?: string; url?: string };
  if (!html || typeof html !== "string") {
    res.status(400).json({ error: "Missing 'html' in body", usage: "POST body: { \"html\": \"<view-source paste>\", \"url\": \"optional\" }" });
    return;
  }
  const users = extractRelayUsers(html);
  res.json({ page_url: url ?? null, total: users.length, users });
});

// Existing: scrape images from pasted HTML
router.post("/facebook/scrape/html", async (req: Request, res: Response) => {
  const { html } = req.body as { html?: string };
  if (!html || typeof html !== "string") { res.status(400).json({ error: "Missing 'html' in body" }); return; }
  const images = extractFbcdnUrls(html).map(u => ({ url: u, type: classifyUrl(u) }));
  const root = parse(html);
  const ogImage = root.querySelector('meta[property="og:image"]')?.getAttribute("content") ?? null;
  const ogTitle = root.querySelector('meta[property="og:title"]')?.getAttribute("content") ?? null;
  if (ogImage && !images.find(i => i.url === ogImage)) images.unshift({ url: ogImage, type: "profile" });
  res.json({ page_title: ogTitle, total: images.length, images });
});

export default router;
