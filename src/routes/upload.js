/**
 * Image upload helper.
 *
 * The browser sends the picture as base64 inside JSON (no multer needed)
 * and we forward it to ImgBB. The API key lives only on the server.
 *
 *   POST /api/upload   { "image": "<base64>" }   ->  { "url": "https://i.ibb.co/..." }
 */
import { Router } from "express";
import { asyncHandler, ApiError, readString } from "../utils.js";
import { requireRole } from "../middleware/auth.js";

const router = Router();

/** Removes a possible "data:image/png;base64," prefix. */
function toBase64(raw) {
  const match = /^data:image\/[a-z+.-]+;base64,(.+)$/i.exec(raw);
  return match ? match[1] : raw;
}

/**
 * POST /api/upload
 */
router.post(
  "/",
  requireRole(),
  asyncHandler(async (req, res) => {
    const apiKey = process.env.IMGBB_API_KEY;

    if (!apiKey) {
      throw new ApiError(
        503,
        "Image upload is not configured yet. Paste an image URL instead.",
      );
    }

    const image = readString(req.body, "image", { maxLength: 8_000_000 });
    if (!/^data:image\/(?:png|jpeg|webp);base64,/i.test(image)) {
      throw new ApiError(400, "Upload a JPG, PNG or WebP image file.");
    }
    const base64 = toBase64(image);

    const form = new FormData();
    form.append("image", base64);

    const response = await fetch(
      `https://api.imgbb.com/1/upload?key=${encodeURIComponent(apiKey)}`,
      { method: "POST", body: form },
    );

    const data = await response.json().catch(() => ({}));

    if (!response.ok || !data?.data?.url) {
      throw new ApiError(502, data?.error?.message || "Image upload failed.");
    }

    res.json({
      url: data.data.url,
      displayUrl: data.data.display_url,
      deleteUrl: data.data.delete_url,
    });
  }),
);

export default router;
