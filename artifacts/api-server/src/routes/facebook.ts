import { Router, type IRouter, type Request, type Response } from "express";

const router: IRouter = Router();

let storedToken: string | null = null;

async function fbFetch(path: string, token: string, params: Record<string, string> = {}) {
  const url = new URL(`https://graph.facebook.com/v21.0${path}`);
  url.searchParams.set("access_token", token);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString());
  const data = await res.json();
  if (!res.ok || (data as { error?: unknown }).error) {
    throw new Error(
      JSON.stringify((data as { error?: unknown }).error ?? { message: "Facebook API error", status: res.status })
    );
  }
  return data;
}

router.post("/facebook/token", (req: Request, res: Response) => {
  const { access_token } = req.body as { access_token?: string };
  if (!access_token || typeof access_token !== "string") {
    res.status(400).json({ error: "access_token is required in request body" });
    return;
  }
  storedToken = access_token;
  res.json({ success: true, message: "Token saved successfully" });
});

router.get("/facebook/token/status", (_req: Request, res: Response) => {
  res.json({ has_token: storedToken !== null });
});

router.delete("/facebook/token", (_req: Request, res: Response) => {
  storedToken = null;
  res.json({ success: true, message: "Token cleared" });
});

router.get("/facebook/me", async (req: Request, res: Response) => {
  const token = (req.query.access_token as string) || storedToken;
  if (!token) {
    res.status(401).json({ error: "No access token. POST /api/facebook/token first, or pass ?access_token=..." });
    return;
  }
  try {
    const data = await fbFetch("/me", token, {
      fields: "id,name,email,picture,birthday,location",
    });
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.get("/facebook/photos", async (req: Request, res: Response) => {
  const token = (req.query.access_token as string) || storedToken;
  if (!token) {
    res.status(401).json({ error: "No access token. POST /api/facebook/token first, or pass ?access_token=..." });
    return;
  }
  const limit = (req.query.limit as string) || "25";
  const after = req.query.after as string | undefined;
  const params: Record<string, string> = {
    fields: "id,name,source,link,created_time,images,place,tags",
    limit,
    type: "uploaded",
  };
  if (after) params.after = after;
  try {
    const data = await fbFetch("/me/photos", token, params);
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.get("/facebook/albums", async (req: Request, res: Response) => {
  const token = (req.query.access_token as string) || storedToken;
  if (!token) {
    res.status(401).json({ error: "No access token. POST /api/facebook/token first, or pass ?access_token=..." });
    return;
  }
  const limit = (req.query.limit as string) || "25";
  const after = req.query.after as string | undefined;
  const params: Record<string, string> = {
    fields: "id,name,description,count,cover_photo,created_time,link",
    limit,
  };
  if (after) params.after = after;
  try {
    const data = await fbFetch("/me/albums", token, params);
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.get("/facebook/albums/:albumId/photos", async (req: Request, res: Response) => {
  const token = (req.query.access_token as string) || storedToken;
  if (!token) {
    res.status(401).json({ error: "No access token. POST /api/facebook/token first, or pass ?access_token=..." });
    return;
  }
  const { albumId } = req.params;
  const limit = (req.query.limit as string) || "25";
  const after = req.query.after as string | undefined;
  const params: Record<string, string> = {
    fields: "id,name,source,link,created_time,images",
    limit,
  };
  if (after) params.after = after;
  try {
    const data = await fbFetch(`/${albumId}/photos`, token, params);
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.get("/facebook/posts", async (req: Request, res: Response) => {
  const token = (req.query.access_token as string) || storedToken;
  if (!token) {
    res.status(401).json({ error: "No access token. POST /api/facebook/token first, or pass ?access_token=..." });
    return;
  }
  const limit = (req.query.limit as string) || "25";
  const after = req.query.after as string | undefined;
  const params: Record<string, string> = {
    fields: "id,message,story,created_time,full_picture,attachments{media,type,subattachments},place,tags",
    limit,
  };
  if (after) params.after = after;
  try {
    const data = await fbFetch("/me/posts", token, params);
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

export default router;
