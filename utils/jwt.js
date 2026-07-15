const jwt = require("jsonwebtoken");
const dotenv = require("dotenv");

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET || "your_jwt_secret_key";

const JWT_REFRESH_SECRET =
  process.env.JWT_REFRESH_SECRET || "your_refresh_secret_key";


/**
 * Generate JWT access token
 * @param {Object} payload - Data to encode in token
 * @returns {String} - JWT token
 */
const generateAccessToken = (payload) => {
  return jwt.sign(payload, JWT_SECRET);
};

/**
 * Generate JWT refresh token
 * @param {Object} payload - Data to encode in token
 * @returns {String} - JWT refresh token
 */
const generateRefreshToken = (payload) => {
  return jwt.sign(payload, JWT_REFRESH_SECRET);
};

/**
 * Generate both access and refresh tokens
 * @param {Object} payload - Data to encode in tokens
 * @returns {Object} - Object containing both tokens
 */
const generateTokens = (payload) => {
  const accessToken = generateAccessToken(payload);
  const refreshToken = generateRefreshToken(payload);

  return {
    accessToken,
    refreshToken,
  };
};

/**
 * Verify JWT access token
 * @param {String} token - JWT token to verify
 * @returns {Object} - Decoded token payload
 */
const verifyAccessToken = (token) => {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    throw error;
  }
};

/**
 * Verify JWT refresh token
 * @param {String} token - JWT refresh token to verify
 * @returns {Object} - Decoded token payload
 */
const verifyRefreshToken = (token) => {
  try {
    return jwt.verify(token, JWT_REFRESH_SECRET);
  } catch (error) {
    throw error;
  }
};

/**
 * Decode JWT token without verification (useful for expired tokens)
 * @param {String} token - JWT token to decode
 * @returns {Object} - Decoded token payload
 */
const decodeToken = (token) => {
  return jwt.decode(token);
};

module.exports = {
  generateAccessToken,
  generateRefreshToken,
  generateTokens,
  verifyAccessToken,
  verifyRefreshToken,
  decodeToken,
};
