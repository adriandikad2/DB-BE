const cloudinary = require("cloudinary").v2
const { CloudinaryStorage } = require("multer-storage-cloudinary")
const multer = require("multer")
const dotenv = require("dotenv")

dotenv.config()

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
})

// Set up storage for drawings
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: "drawing-battle",
    format: async (req, file) => "png",
    public_id: (req, file) => `drawing-${Date.now()}`,
  },
})

// Create multer upload middleware
const upload = multer({ storage: storage })

module.exports = {
  cloudinary,
  upload,
}
