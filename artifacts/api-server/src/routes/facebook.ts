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

interface WorkEntry    { employer: string; position: string | null; start_year: number | null; end_year: number | null; }
interface EduEntry     { school: string; type: string | null; year: string | null; }
interface BirthdayInfo { day: number | null; month: number | null; year: number | null; text: string | null; }

interface RelayUser {
  id: string;
  url: string | null;
  profile_url: string | null;
  short_name: string | null;
  name: string | null;
  gender: string | null;
  birthday: BirthdayInfo | null;
  hometown: string | null;
  current_city: string | null;
  relationship_status: string | null;
  work: WorkEntry[];
  education: EduEntry[];
  phones: string[];
  emails: string[];
  follower_count: number | null;
  friend_count: number | null;
  profile_picture: string | null;
  cover_photo: string | null;
  bio: string | null;
  verified: boolean | null;
}

// ─── helpers shared between relay & deepParse ──────────────────────────────

function fbUnescape(s: string): string {
  return s
    // data-sjs blocks double-encode: \\uXXXX → actual char (handle first)
    .replace(/\\\\u([0-9a-fA-F]{4})/g, (_, c) => String.fromCharCode(parseInt(c, 16)))
    // standard JSON \uXXXX escapes
    .replace(/\\u([0-9a-fA-F]{4})/g,   (_, c) => String.fromCharCode(parseInt(c, 16)))
    .replace(/\\\//g, "/")
    .replace(/\\\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"');
}

/** Extract birthday from all known FB formats found anywhere in a text chunk */
function parseBirthday(chunk: string): BirthdayInfo | null {
  // Format 1: {"day":D,"month":M,"year":Y}  (any key order)
  const obj = chunk.match(/"birthdate"\s*:\s*\{([^}]{0,200})\}/s)
           ?? chunk.match(/"birthday"\s*:\s*\{([^}]{0,200})\}/s);
  if (obj) {
    const inner = obj[1];
    const day   = inner.match(/"day"\s*:\s*(\d+)/)?.[1] ?? null;
    const month = inner.match(/"month"\s*:\s*(\d+)/)?.[1] ?? null;
    const year  = inner.match(/"year"\s*:\s*(\d+)/)?.[1] ?? null;
    const text  = inner.match(/"text"\s*:\s*"([^"]+)"/)?.[1] ?? null;
    if (day || month || year || text) {
      return { day: day ? +day : null, month: month ? +month : null, year: year ? +year : null, text };
    }
  }
  // Format 2: "birth_date":"MM/DD/YYYY"
  const bd2 = chunk.match(/"birth_date"\s*:\s*"(\d{1,2}\/\d{1,2}\/\d{4})"/);
  if (bd2) {
    const [m, d, y] = bd2[1].split("/").map(Number);
    return { day: d ?? null, month: m ?? null, year: y ?? null, text: bd2[1] };
  }
  // Format 3: "birthday_reminder_info":{..."date":"Jan 1"}
  const bd3 = chunk.match(/"birthday_reminder_info"\s*:\s*\{[^}]{0,400}"date"\s*:\s*"([^"]+)"/s);
  if (bd3) return { day: null, month: null, year: null, text: bd3[1] };
  // Format 4: birth_day / birth_month / birth_year as separate keys
  const d4 = chunk.match(/"birth_day"\s*:\s*(\d+)/)?.[1];
  const m4 = chunk.match(/"birth_month"\s*:\s*(\d+)/)?.[1];
  const y4 = chunk.match(/"birth_year"\s*:\s*(\d+)/)?.[1];
  if (d4 || m4 || y4) return { day: d4 ? +d4 : null, month: m4 ? +m4 : null, year: y4 ? +y4 : null, text: null };
  return null;
}

/** Extract structured work history from a text chunk */
function parseWork(chunk: string): WorkEntry[] {
  const entries: WorkEntry[] = [];
  // Pattern: "employer":{"name":"X"}...optional "position":{"name":"Y"}
  const re = /"employer"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"[^}]*\}/gs;
  let m: RegExpExecArray | null;
  while ((m = re.exec(chunk)) !== null) {
    const employerName = m[1];
    // look for position nearby (within 400 chars after employer block)
    const nearby = chunk.slice(m.index, Math.min(chunk.length, m.index + 600));
    const pos    = nearby.match(/"position"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"/s)?.[1] ?? null;
    const sy     = nearby.match(/"start_year"\s*:\s*(\d{4})/)?.[1] ?? nearby.match(/"start_date"\s*:\s*"(\d{4})"/)?.[1] ?? null;
    const ey     = nearby.match(/"end_year"\s*:\s*(\d{4})/)?.[1]   ?? nearby.match(/"end_date"\s*:\s*"(\d{4})"/)?.[1]   ?? null;
    entries.push({ employer: employerName, position: pos, start_year: sy ? +sy : null, end_year: ey ? +ey : null });
  }
  return entries;
}

/** Extract structured education history from a text chunk */
function parseEducation(chunk: string): EduEntry[] {
  const entries: EduEntry[] = [];
  const re = /"school"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"[^}]*\}/gs;
  let m: RegExpExecArray | null;
  while ((m = re.exec(chunk)) !== null) {
    const schoolName = m[1];
    const nearby = chunk.slice(m.index, Math.min(chunk.length, m.index + 600));
    const type = nearby.match(/"type"\s*:\s*"([^"]+)"/)?.[1] ?? null;
    const year = nearby.match(/"year"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"/s)?.[1]
              ?? nearby.match(/"graduation_year"\s*:\s*(\d{4})/)?.[1]
              ?? null;
    entries.push({ school: schoolName, type, year });
  }
  return entries;
}

function extractRelayUsers(html: string): RelayUser[] {
  const users = new Map<string, RelayUser>();

  // Match the specific Relay User pattern Facebook embeds
  const marker = /"__typename"\s*:\s*"User"\s*,\s*"__isEntity"\s*:\s*"User"\s*,\s*"__isActor"\s*:\s*"User"\s*,\s*"id"\s*:\s*"(\d+)"/g;

  let match: RegExpExecArray | null;
  while ((match = marker.exec(html)) !== null) {
    const id = match[1];
    if (users.has(id)) continue;

    // Large window: 200 chars before (for context), 10000 after (to capture all nested profile fields)
    const winStart = Math.max(0, match.index - 200);
    const winEnd   = Math.min(html.length, match.index + 10000);
    const chunk    = html.slice(winStart, winEnd);

    const pick = (re: RegExp) => { const m = chunk.match(re); return m?.[1] ? fbUnescape(m[1]) : null; };

    const rawUrl   = pick(/"url"\s*:\s*"([^"]+)"/);
    const rawPUrl  = pick(/"profile_url"\s*:\s*"([^"]+)"/);
    const rawShort = pick(/"short_name"\s*:\s*"([^"]{1,80})"/);
    const rawName  = pick(/"(?:name|full_name)"\s*:\s*"([A-Za-zÀ-ÿ\u00C0-\u024F0-9 .''`-]{1,120})"/);
    const rawGend  = pick(/"gender"\s*:\s*"([^"]+)"/);
    const rawRel   = pick(/"relationship_status"\s*:\s*"([^"]+)"/);
    const rawFoll  = pick(/"follower_count"\s*:\s*(\d+)/);
    const rawFriendCount = pick(/"friend_count"\s*:\s*(\d+)/);
    const rawVerif = pick(/"is_verified"\s*:\s*(true|false)/);
    const rawBio   = pick(/"(?:biography|about)"\s*:\s*\{[^}]*"text"\s*:\s*"([^"]{1,500})"/s);

    // Location – city name (handles nested: "hometown":{"name":"..."} and deeper nesting)
    const rawHt   = pick(/"hometown"\s*:\s*\{[^}]{0,300}"name"\s*:\s*"([^"]+)"/s)
                 ?? pick(/"hometown_city"\s*:\s*\{[^}]{0,300}"name"\s*:\s*"([^"]+)"/s);
    const rawCity = pick(/"current_city"\s*:\s*\{[^}]{0,300}"name"\s*:\s*"([^"]+)"/s)
                 ?? pick(/"current_location"\s*:\s*\{[^}]{0,300}"name"\s*:\s*"([^"]+)"/s);

    // Profile picture – prefer high-res uri
    const rawPic  = pick(/"profile_picture_uri"\s*:\s*"([^"]+)"/)
                 ?? pick(/"profile_picture"\s*:\s*\{[^}]{0,200}"uri"\s*:\s*"([^"]+)"/s);

    // Cover photo uri
    const rawCover = pick(/"cover_photo"\s*:\s*\{[^}]{0,600}"uri"\s*:\s*"([^"]+)"/s);

    // Contact info (if publicly embedded)
    const rawPhones = [...chunk.matchAll(/"(?:phone|mobile|phone_number)"\s*:\s*"(\+?[\d\s\-().]{7,20})"/g)]
      .map(m => m[1]).filter(p => p.replace(/\D/g, "").length >= 7);
    const rawEmails = [...chunk.matchAll(/"(?:email|contact_email)"\s*:\s*"([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})"/g)]
      .map(m => m[1]).filter(e => !e.includes("facebook.com") && !e.includes("sentry.io"));

    // Birthday
    const birthday = parseBirthday(chunk);

    // Work & Education (structured)
    const work      = parseWork(chunk);
    const education = parseEducation(chunk);

    users.set(id, {
      id,
      url:                 rawUrl,
      profile_url:         rawPUrl,
      short_name:          rawShort,
      name:                rawName,
      gender:              rawGend,
      birthday,
      hometown:            rawHt,
      current_city:        rawCity,
      relationship_status: rawRel,
      work,
      education,
      phones:              [...new Set(rawPhones)],
      emails:              [...new Set(rawEmails)],
      follower_count:      rawFoll ? Number(rawFoll) : null,
      friend_count:        rawFriendCount ? Number(rawFriendCount) : null,
      profile_picture:     rawPic,
      cover_photo:         rawCover,
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

  // Derive username from the profile URL (most reliable — avoids picking up viewer's own username)
  // profile_user section contains "url":"https://www.facebook.com/SLUG" for the viewed user
  const profileSlugFromUrl = (() => {
    const rawUrl = html.match(/"profile_user"\s*:\s*\{[^}]{0,500}"url"\s*:\s*"(https:\/\/(?:www\.)?facebook\.com\/([^"/?\\]+))"/s)?.[2]
                ?? html.match(/"header_top_row"[\s\S]{0,1000}"url"\s*:\s*"https:\/\/(?:www\.)?facebook\.com\/([^"/?\\]+)"/s)?.[1]
                ?? null;
    // Exclude numeric IDs (those are not vanity slugs)
    return rawUrl && !/^\d+$/.test(rawUrl) ? rawUrl : null;
  })();

  const username = profileSlugFromUrl
    ?? first(html,
      /"vanity"\s*:\s*"([^"]{2,60})"/,
      /"profile_url_params".*?"alias"\s*:\s*"([^"]+)"/s,
    )
    ?? (pageUrl ? pageUrl.split("facebook.com/")[1]?.split("?")[0]?.split("/")[0] : null)
    ?? first(html, /"username"\s*:\s*"([^"]{2,60})"/);  // last resort (may be viewer's own)

  // ── profile_user section — most reliable for the VIEWED profile (not viewer) ──
  // "profile_user":{"__isProfile":"User","name":"..."} or header_top_row variant
  const profileUserM = html.match(/"profile_user"\s*:\s*\{"__isProfile"\s*:\s*"User"\s*,\s*"name"\s*:\s*"([^"]+)"([\s\S]{0,8000})/s)
                    ?? html.match(/"profile_user"\s*:\s*\{"__isProfile[^}]{0,100}"name"\s*:\s*"([^"]+)"([\s\S]{0,8000})/s);
  const profileUserChunk = profileUserM ? (profileUserM[0]) : "";

  // ── __isProfile section (fallback) ──
  const isProfileIdx = html.indexOf('"__isProfile":"User"');
  const isProfileChunk = isProfileIdx >= 0
    ? html.slice(Math.max(0, isProfileIdx - 50), Math.min(html.length, isProfileIdx + 8000))
    : "";

  // Use profile_user chunk first, then __isProfile as fallback
  const mainChunk = profileUserChunk || isProfileChunk;

  // ── Profile info ──
  const name = (mainChunk
    ? (mainChunk.match(/"name"\s*:\s*"([^"]{2,120})"/)?.[1] ?? null)
    : null)
    ?? first(html,
      /"profile_name"\s*:\s*"([^"]{2,80})"/,
    ) ?? ogTitle;

  // gender often lives in __isProfile chunk (not always in profile_user chunk)
  const gender = first(mainChunk, /"gender"\s*:\s*"([A-Z]+)"/)
              ?? first(isProfileChunk, /"gender"\s*:\s*"([A-Z]+)"/)
              ?? first(html, /"gender"\s*:\s*"(MALE|FEMALE|OTHER)"/);

  // Profile picture from profile section
  const profilePicFromSection = mainChunk
    ? fbUnescape(mainChunk.match(/"profilePicLarge"\s*:\s*\{"uri"\s*:\s*"([^"]+)"/)?.[1] ?? "")
    : null;

  // is_viewer_friend (only meaningful on logged-in HTML)
  const isViewerFriend = mainChunk
    ? (mainChunk.match(/"is_viewer_friend"\s*:\s*(true|false)/)?.[1] === "true" ? true : false)
    : null;

  // Profile URL from profile section
  const profileUrlFromSection = mainChunk
    ? fbUnescape(mainChunk.match(/"url"\s*:\s*"(https:\/\/(?:www\.)?facebook\.com\/[^"]+)"/)?.[1] ?? "")
    : null;

  const birthdayInfo = parseBirthday(html);

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
    /"hometown"\s*:\s*\{[^}]{0,300}"name"\s*:\s*"([^"]+)"/s,
    /"hometown_city"\s*:\s*\{[^}]{0,300}"name"\s*:\s*"([^"]+)"/s,
  );
  const currentCity = first(html,
    /"current_city"\s*:\s*\{[^}]{0,300}"name"\s*:\s*"([^"]+)"/s,
    /"current_location"\s*:\s*\{[^}]{0,300}"name"\s*:\s*"([^"]+)"/s,
    /"current_address"\s*:\s*\{[^}]{0,300}"city"\s*:\s*"([^"]+)"/s,
  );

  // ── Tile section texts (e.g. "Sống ở Hà Nội", "Quê ở ...", "Học tại ...") ──
  // Facebook renders these as display strings inside profile_feature sections
  const tileTexts: string[] = [];
  const tileRe = /"profile_feature"\s*:\s*"(?:PERSONAL_DETAILS|HOMETOWN|CURRENT_CITY|WORK|EDUCATION)"[\s\S]{0,3000}/gs;
  for (const sec of html.matchAll(tileRe)) {
    for (const tm of sec[0].matchAll(/"text"\s*:\s*"([^"]{2,200})"/g)) {
      const t = fbUnescape(tm[1]);
      if (!tileTexts.includes(t) && !/^[{[]/.test(t)) tileTexts.push(t);
    }
  }

  // ── Education institutions from Relay User blocks (school pages embedded in edu section) ──
  // Facebook embeds school page data as Relay nodes BEFORE the education_type field.
  // Strategy: for each education_type occurrence, scan 3000 chars BEFORE it for school data.
  const eduInstitutions: { id: string; name: string; url: string; type: string | null }[] = [];
  const eduTypeRe = /"education_type"\s*:\s*"([^"]+)"/g;
  const seenEduIds = new Set<string>();
  for (const eduTypeM of html.matchAll(eduTypeRe)) {
    const eduType    = eduTypeM[1];
    const pos        = eduTypeM.index!;
    // Scan window: 3000 chars before + 1000 chars after education_type
    const window     = html.slice(Math.max(0, pos - 3000), Math.min(html.length, pos + 1000));
    const shortName  = window.match(/"short_name"\s*:\s*"([^"]{2,200})"/)?.[1] ?? null;
    const instUrl    = window.match(/"url"\s*:\s*"(https:\/\/[^"]*facebook\.com\/[^"]+)"/)?.[1] ?? null;
    const instId     = window.match(/"id"\s*:\s*"(\d{5,20})"/)?.[1] ?? null;
    const nameMatch  = window.match(/"name"\s*:\s*"([^"]{2,200})"/)?.[1] ?? null;
    const bestName   = shortName ?? nameMatch ?? null;
    if (bestName && instId && !seenEduIds.has(instId)) {
      seenEduIds.add(instId);
      eduInstitutions.push({
        id:   instId,
        name: fbUnescape(bestName),
        url:  instUrl ? fbUnescape(instUrl) : "",
        type: eduType,
      });
    }
  }

  // ── Work & Education (structured) ──
  const workEntries = parseWork(html);
  const eduEntries  = parseEducation(html);

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

  // ── Social context (profile_social_context) ──
  // Contains human-readable texts like "181 người bạn" and "1 bạn chung"
  // plus facepile_profiles (mutual friends shown on profile card)
  const socialCtxM = html.match(/"profile_social_context"\s*:\s*\{([\s\S]{0,3000})/s);
  const socialCtxChunk = socialCtxM ? socialCtxM[1] : "";

  // Extract text items (e.g. "181 người bạn", "1 bạn chung")
  const socialContextTexts: Array<{ text: string; url: string | null }> = [];
  const scItemRe = /"text"\s*:\s*\{[^}]{0,500}"text"\s*:\s*"([^"]{2,200})"[^}]{0,200}\}[^}]{0,200}"uri"\s*:\s*"([^"]*)"/gs;
  for (const scm of socialCtxChunk.matchAll(scItemRe)) {
    socialContextTexts.push({ text: fbUnescape(scm[1]), url: fbUnescape(scm[2]) || null });
  }
  // Simpler fallback: just grab all text values from social context
  if (socialContextTexts.length === 0 && socialCtxChunk) {
    for (const tm of socialCtxChunk.matchAll(/"text"\s*:\s*"([^"]{3,200})"/g)) {
      const t = fbUnescape(tm[1]);
      if (/\d/.test(t) && !socialContextTexts.find(x => x.text === t)) {
        socialContextTexts.push({ text: t, url: null });
      }
    }
  }

  // Parse friend count and mutual friends count from social context texts
  const friendCountFromText = (() => {
    for (const item of socialContextTexts) {
      const m = item.text.match(/^([\d,.]+)\s+(?:người bạn|friends?)\b/i);
      if (m) return m[1].replace(/[,.]/g, "");
    }
    return null;
  })();
  const mutualFriendCountFromText = (() => {
    for (const item of socialContextTexts) {
      const m = item.text.match(/^([\d,.]+)\s+(?:bạn chung|mutual friends?)\b/i);
      if (m) return m[1].replace(/[,.]/g, "");
    }
    return null;
  })();

  // Facepile profiles (mutual friends shown on profile card)
  const facepileM = socialCtxChunk.match(/"facepile_profiles"\s*:\s*\[([\s\S]{0,5000})\]/s);
  const facepileProfiles: Array<{ name: string; pic: string | null }> = [];
  if (facepileM) {
    for (const fp of facepileM[1].matchAll(/"name"\s*:\s*"([^"]{2,100})"\s*,\s*"profile_picture"\s*:\s*\{\s*"uri"\s*:\s*"([^"]+)"/g)) {
      facepileProfiles.push({ name: fbUnescape(fp[1]), pic: fbUnescape(fp[2]) });
    }
  }

  // ── Tab URLs (followers / following / likes) ──
  // Look for "tab_key":"X","tracking":"X","url":"..." pattern (url is the tab's own URL)
  const tabUrlFor = (tabKey: string): string | null => {
    // Pattern: tab_key + optional fields + url, stopping before next tab_key
    const re = new RegExp(`"tab_key"\\s*:\\s*"${tabKey}"[^}]{0,400}?"url"\\s*:\\s*"(https://[^"]+)"`, "s");
    const m = html.match(re);
    if (m) return fbUnescape(m[1]);
    // Fallback: construct from page_url
    const base = (profileUrlFromSection || ogUrl || pageUrl || "").replace(/\/$/, "");
    if (!base.includes("facebook.com")) return null;
    return `${base}/${tabKey}`;
  };
  const followersTabUrl = tabUrlFor("followers");
  const followingTabUrl = tabUrlFor("following");
  const likesTabUrl     = tabUrlFor("likes");
  const friendsTabUrl   = tabUrlFor("friends");

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
      uid:              uid ?? null,
      username:         username ?? null,
      name:             name ? fbUnescape(name) : null,
      page_url:         profileUrlFromSection || ogUrl || canonical || pageUrl || null,
      og_type:          ogType ?? null,
      is_viewer_friend: isViewerFriend,
    },
    // ── Profile
    profile: {
      gender:              gender ?? null,
      birthday:            birthdayInfo,
      account_created_at:  createdTime ? new Date(Number(createdTime) * 1000).toISOString() : null,
      account_created_ts:  createdTime ? Number(createdTime) : null,
      relationship_status: relationshipStatus ?? null,
      hometown:            hometown ?? null,
      current_city:        currentCity ?? null,
      follower_count:      followerCount ? Number(followerCount) : null,
      friend_count:        friendCount ? Number(friendCount) : (friendCountFromText ? Number(friendCountFromText) : null),
      mutual_friend_count: mutualFriendCountFromText ? Number(mutualFriendCountFromText) : null,
      bio:                 ogDesc ?? metaDesc ?? null,
      profile_picture:     profilePicFromSection || ogImage || null,
      // Human-readable display texts Facebook shows on the About tab
      display_info:        tileTexts.filter(t => t.length > 2 && !/^[\d.]+$/.test(t)).slice(0, 20),
    },
    // ── Social (friends, followers, following, likes tabs) ──
    social: {
      // Human-readable social counts (e.g. "181 người bạn", "1 bạn chung")
      // NOTE: Facebook does NOT embed follower/following counts as numbers in profile HTML.
      // These are loaded dynamically per-tab. Scrape the tab URLs below to get lists.
      social_context:       socialContextTexts,
      // Mutual friends shown on the profile card (name + profile picture)
      mutual_friends_shown: facepileProfiles,
      // Tab URLs — fetch these to get full follower/following/likes lists
      tab_urls: {
        followers: followersTabUrl,
        following: followingTabUrl,
        likes:     likesTabUrl,
        friends:   friendsTabUrl,
      },
    },
    // ── Work & Education
    work_education: {
      work:                workEntries,
      education:           eduEntries,
      education_institutions: eduInstitutions,
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
