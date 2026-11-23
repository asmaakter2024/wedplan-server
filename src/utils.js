/**
 * Small helpers shared by every route file.
 */
import { ObjectId } from "mongodb";

/** An error that carries an HTTP status code. */
export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Wraps an async route handler so thrown errors reach the error middleware.
 * Express 5 handles async errors by itself, but this keeps every file
 * consistent and works even if a handler is called from a callback.
 */
export const asyncHandler = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

/**
 * Converts a request parameter into a real MongoDB ObjectId.
 * Throws a 400 error when the value is not a valid id.
 */
export function toObjectId(value, message = "Invalid id.") {
  if (typeof value !== "string" || !/^[a-f0-9]{24}$/i.test(value)) {
    throw new ApiError(400, message);
  }
  return new ObjectId(value);
}

/** Escapes user input so it can safely be used inside a RegExp. */
export function escapeRegex(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Builds a case-insensitive "contains" RegExp from user input. */
export function contains(value = "") {
  return new RegExp(escapeRegex(String(value).trim()), "i");
}

/** Reads a non-empty string from the request body. */
export function readString(body, field, { required = true, maxLength = 500 } = {}) {
  const raw = body?.[field];
  const value = typeof raw === "string" ? raw.trim() : "";

  if (!value && required) {
    throw new ApiError(400, `"${field}" is required.`);
  }
  if (value.length > maxLength) {
    throw new ApiError(400, `"${field}" must be at most ${maxLength} characters.`);
  }
  return value;
}

/** Reads a positive number from the request body. */
export function readNumber(body, field, { required = true, min = 0, max = 1000000 } = {}) {
  const raw = body?.[field];
  const value = raw === undefined || raw === null || raw === "" ? NaN : Number(raw);

  if (Number.isNaN(value)) {
    if (required) throw new ApiError(400, `"${field}" must be a number.`);
    return undefined;
  }
  if (value < min || value > max) {
    throw new ApiError(400, `"${field}" must be between ${min} and ${max}.`);
  }
  return value;
}

/** Public fields we return for a user (never leaks internal data). */
export const USER_PUBLIC_FIELDS = {
  name: 1,
  email: 1,
  image: 1,
  role: 1,
  businessName: 1,
  phone: 1,
  address: 1,
  bio: 1,
  subscription: 1,
  isBlocked: 1,
  createdAt: 1,
};
