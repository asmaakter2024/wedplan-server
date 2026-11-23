/**
 * Error handling middleware.
 *
 * Every error in the API is answered with:  { "message": "..." }
 * — which is exactly what the client's apiFetch() helper expects.
 */
import { ApiError } from "../utils.js";

export function notFoundHandler(req, res) {
  res.status(404).json({ message: `Route not found: ${req.method} ${req.originalUrl}` });
}

export function errorHandler(error, req, res, next) {
  // Known error (thrown intentionally by a route)
  if (error instanceof ApiError) {
    return res.status(error.status).json({ message: error.message });
  }

  // Malformed JSON sent by the client (body-parser attaches status: 400)
  const httpStatus = error?.status || error?.statusCode;
  if (error?.type === "entity.parse.failed" || httpStatus === 400) {
    return res.status(400).json({ message: "Invalid JSON in the request body." });
  }

  // MongoDB duplicate key / cast problems -> friendly messages
  if (error?.code === 11000) {
    return res.status(409).json({ message: "That record already exists." });
  }

  console.error("Unhandled API error:", error);
  res.status(500).json({ message: "Something went wrong. Please try again later." });
}
