/**
 * Custom Error Classes and Error Handler Middleware
 */

class AppError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

class ValidationError extends AppError {
  constructor(message) {
    super(message, 400);
  }
}

class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized access") {
    super(message, 401);
  }
}

class ForbiddenError extends AppError {
  constructor(message = "Access forbidden") {
    super(message, 403);
  }
}

class NotFoundError extends AppError {
  constructor(message = "Resource not found") {
    super(message, 404);
  }
}

class ConflictError extends AppError {
  constructor(message = "Resource already exists") {
    super(message, 409);
  }
}

// Global error handler middleware
const errorHandler = (err, req, res, next) => {
  let error = { ...err };
  error.message = err.message;

  // Log error for development
  if (process.env.NODE_ENV === "development") {
    console.error("Error:", err);
  }

  // PostgreSQL errors
  if (err.code === "23505") {
    // Unique violation
    const field = err.detail?.match(/Key \((.*?)\)/)?.[1] || "field";
    error = new ConflictError(`${field} already exists`);
  }

  if (err.code === "23503") {
    // Foreign key violation
    error = new ValidationError("Referenced record does not exist");
  }

  if (err.code === "22P02") {
    // Invalid text representation
    error = new ValidationError("Invalid data format");
  }

  // JWT errors
  if (err.name === "JsonWebTokenError") {
    error = new UnauthorizedError("Invalid token");
  }

  if (err.name === "TokenExpiredError") {
    error = new UnauthorizedError("Token expired");
  }

  // Send error response
  res.status(error.statusCode || 500).json({
    success: false,
    message: error.message || "Internal Server Error",
    ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
    timestamp: new Date().toISOString(),
  });
};

// Catch async errors wrapper
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = {
  AppError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  errorHandler,
  asyncHandler,
};
