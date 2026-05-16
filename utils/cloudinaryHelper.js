const cloudinary = require("cloudinary").v2;
const streamifier = require("streamifier");

// ---------------------------------------------------------------------------
// Cloudinary configuration
// Expects these env vars to be set:
//   CLOUDINARY_CLOUD_NAME
//   CLOUDINARY_API_KEY
//   CLOUDINARY_API_SECRET
// ---------------------------------------------------------------------------
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * Upload a file buffer (or stream) to Cloudinary.
 *
 * @param {Buffer|ReadableStream} fileInput  - Raw file buffer or readable stream.
 * @param {object}               options
 * @param {string}               options.folder      - Cloudinary folder (e.g. "attendance/selfies").
 * @param {string}               [options.publicId]  - Optional explicit public_id.
 * @param {string}               [options.resourceType="image"] - "image" | "video" | "raw" | "auto".
 * @param {object}               [options.transformation] - Optional Cloudinary transformation options.
 *
 * @returns {Promise<{ url: string, secureUrl: string, publicId: string, format: string }>}
 */
async function uploadToCloudinary(fileInput, options = {}) {
    const {
        folder = "attendance/selfies",
        publicId,
        resourceType = "image",
        transformation,
    } = options;

    return new Promise((resolve, reject) => {
        const uploadOptions = {
            folder,
            resource_type: resourceType,
            ...(publicId && { public_id: publicId }),
            ...(transformation && { transformation }),
        };

        const handleResult = (error, result) => {
            if (error) return reject(error);
            resolve({
                url: result.url,
                secureUrl: result.secure_url,
                publicId: result.public_id,
                format: result.format,
            });
        };

        const uploadStream = cloudinary.uploader.upload_stream(uploadOptions, handleResult);

        if (Buffer.isBuffer(fileInput)) {
            // Buffer → pipe through streamifier
            streamifier.createReadStream(fileInput).pipe(uploadStream);
        } else if (typeof fileInput.pipe === "function") {
            // Already a readable stream
            fileInput.pipe(uploadStream);
        } else {
            reject(new Error("fileInput must be a Buffer or a readable stream"));
        }
    });
}

/**
 * Upload a check-in selfie to Cloudinary.
 *
 * Stores under: attendance/check-in/<employeeId>/<timestamp>
 *
 * @param {Buffer|ReadableStream} fileBuffer
 * @param {string|number}         employeeId
 * @returns {Promise<{ url: string, secureUrl: string, publicId: string, format: string }>}
 */
async function uploadCheckInSelfie(fileBuffer, employeeId) {
    const timestamp = Date.now();
    return uploadToCloudinary(fileBuffer, {
        folder: `attendance/check-in/${employeeId}`,
        publicId: `checkin_${employeeId}_${timestamp}`,
        transformation: { quality: "auto", fetch_format: "auto" },
    });
}

/**
 * Upload a check-out selfie to Cloudinary.
 *
 * Stores under: attendance/check-out/<employeeId>/<timestamp>
 *
 * @param {Buffer|ReadableStream} fileBuffer
 * @param {string|number}         employeeId
 * @returns {Promise<{ url: string, secureUrl: string, publicId: string, format: string }>}
 */
async function uploadCheckOutSelfie(fileBuffer, employeeId) {
    const timestamp = Date.now();
    return uploadToCloudinary(fileBuffer, {
        folder: `attendance/check-out/${employeeId}`,
        publicId: `checkout_${employeeId}_${timestamp}`,
        transformation: { quality: "auto", fetch_format: "auto" },
    });
}

/**
 * Delete a file from Cloudinary by its public_id.
 *
 * @param {string} publicId
 * @param {string} [resourceType="image"]
 * @returns {Promise<{ result: string }>}
 */
async function deleteFromCloudinary(publicId, resourceType = "image") {
    return cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
}

module.exports = {
    uploadToCloudinary,
    uploadCheckInSelfie,
    uploadCheckOutSelfie,
    deleteFromCloudinary,
};