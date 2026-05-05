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

function extractFbcdnUrls(html: string): string[] {
  const seen = new Set<string>();
  const results: string[] = [];

  // Pattern to match Facebook CDN image URLs
  const patterns = [
    // xlink:href="..." and href="..."
    /(?:xlink:href|href)="(https:\/\/scontent[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/gi,
    // src="..."
    /src="(https:\/\/scontent[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/gi,
    // JSON-escaped URLs: "https:\/\/scontent..."
    /"(https:\\\/\\\/scontent[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/gi,
    // Plain URLs in JS/JSON blocks
    /(https:\/\/scontent[\w.\-/]+\.(?:jpg|jpeg|png|webp)(?:\?[^"'\s<>]*)?)/gi,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      let url = match[1];
      // Unescape JSON-escaped forward slashes
      url = url.replace(/\\\//g, "/");
      // Decode HTML entities
      url = url.replace(/&amp;/g, "&");
      // Only keep if not already seen
      if (!seen.has(url)) {
        seen.add(url);
        results.push(url);
      }
    }
  }

  return results;
}

function classifyUrl(url: string): "profile" | "post" | "thumbnail" | "other" {
  if (url.includes("_s40x40") || url.includes("_s50x50") || url.includes("_s32x32")) return "thumbnail";
  if (url.includes("cp0_dst-jpg_s") || url.includes("_p") ) return "profile";
  if (url.includes("_n.jpg") || url.includes("_n.png")) return "post";
  return "other";
}

router.get("/facebook/scrape", async (req: Request, res: Response) => {
  const { url } = req.query as { url?: string };

  if (!url) {
    res.status(400).json({
      error: "Missing required query param: url",
      example: "/api/facebook/scrape?url=https://www.facebook.com/username",
    });
    return;
  }

  // Validate it's a Facebook URL
  if (!url.includes("facebook.com")) {
    res.status(400).json({ error: "URL must be a facebook.com address" });
    return;
  }

  try {
    const response = await fetch(url, {
      headers: BROWSER_HEADERS,
      redirect: "follow",
    });

    if (!response.ok) {
      res.status(502).json({
        error: `Facebook returned HTTP ${response.status}`,
        hint: "The page may require login or the URL is invalid",
      });
      return;
    }

    const html = await response.text();
    const allUrls = extractFbcdnUrls(html);

    // Classify and group images
    const images = allUrls.map((imageUrl) => ({
      url: imageUrl,
      type: classifyUrl(imageUrl),
    }));

    // Also try to extract basic page info
    const root = parse(html);
    const title = root.querySelector("title")?.text?.trim() ?? null;
    const ogImage = root.querySelector('meta[property="og:image"]')?.getAttribute("content") ?? null;
    const ogTitle = root.querySelector('meta[property="og:title"]')?.getAttribute("content") ?? null;

    if (ogImage && !images.find((i) => i.url === ogImage)) {
      images.unshift({ url: ogImage, type: "profile" });
    }

    res.json({
      page_url: url,
      page_title: ogTitle ?? title,
      total: images.length,
      note:
        images.length === 0
          ? "Không tìm thấy ảnh. Facebook có thể yêu cầu đăng nhập để xem trang này."
          : null,
      images,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post("/facebook/scrape/html", async (req: Request, res: Response) => {
  const { html } = req.body as { html?: string };

  if (!html || typeof html !== "string") {
    res.status(400).json({
      error: "Missing 'html' field in request body",
      usage: "POST /api/facebook/scrape/html with body: { \"html\": \"<paste view-source here>\" }",
    });
    return;
  }

  const allUrls = extractFbcdnUrls(html);

  const images = allUrls.map((imageUrl) => ({
    url: imageUrl,
    type: classifyUrl(imageUrl),
  }));

  const root = parse(html);
  const ogImage = root.querySelector('meta[property="og:image"]')?.getAttribute("content") ?? null;
  const ogTitle = root.querySelector('meta[property="og:title"]')?.getAttribute("content") ?? null;

  if (ogImage && !images.find((i) => i.url === ogImage)) {
    images.unshift({ url: ogImage, type: "profile" });
  }

  res.json({
    page_title: ogTitle ?? null,
    total: images.length,
    images,
  });
});

export default router;
