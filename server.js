const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(cors());

const JWT_SECRET = process.env.JWT_SECRET || "sasta_matrix_key_2026";
const MONGO_URI = process.env.MONGO_URI;

// Connect to Database
mongoose.connect(MONGO_URI)
    .then(() => console.log("✅ Mainframe Connected: Sasta Database Online."))
    .catch(err => console.error("❌ Mainframe Connection Failed:", err));

// ---------------------------------------------------------
// DATABASE MODELS
// ---------------------------------------------------------
const userSchema = new mongoose.Schema({
    fullName: { type: String, required: true },
    whatsapp: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true }
});

const User = mongoose.model('User', userSchema);

// ---------------------------------------------------------
// REGISTRATION ROUTE (FIXED)
// ---------------------------------------------------------
app.post('/api/register', async (req, res) => {
    try {
        const { fullName, whatsapp, email, username, password } = req.body;

        // Validation: Check if all fields are present
        if (!fullName || !whatsapp || !email || !username || !password) {
            return res.status(400).json({ message: "All fields are required." });
        }

        // Check if user already exists
        const existingUser = await User.findOne({ email });
        if (existingUser) {
            return res.status(409).json({ message: "Email already registered." });
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Create new user
        const newUser = new User({
            fullName,
            whatsapp,
            email,
            username,
            password: hashedPassword
        });

        await newUser.save();
        res.status(201).json({ message: "Registration successful!" });

    } catch (error) {
        // This will print the actual error to your Render Logs
        console.error("Registration Error:", error);
        res.status(500).json({ 
            message: "Internal Server Error", 
            error: error.message 
        });
    }
});

// ... (Keep your existing Order/Mission routes here)

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
