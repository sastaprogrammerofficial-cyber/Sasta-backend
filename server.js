const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Middleware
app.use(express.json({ limit: '10mb' })); // 10mb limit to handle bulk CSV question uploads safely
app.use(cors()); // Allows your GitHub Pages frontend to talk to this backend

// Secrets (In production, Render will provide these via Environment Variables)
const JWT_SECRET = process.env.JWT_SECRET || "sasta_matrix_key_2026";
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/sasta_programmer";

mongoose.connect(MONGO_URI)
    .then(() => console.log("✅ Mainframe Connected: Sasta Database Online."))
    .catch(err => console.error("❌ Mainframe Connection Failed:", err));


// ---------------------------------------------------------
// DATABASE MODELS
// ---------------------------------------------------------

// 1. User (Student) Schema
const userSchema = new mongoose.Schema({
    fullName: { type: String, required: true },
    whatsapp: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true }, // Encrypted via bcrypt
    
    // RPG Stats
    xp: { type: Number, default: 0 },
    missionsCompleted: { type: Number, default: 0 },
    accuracy: { type: Number, default: 0 },
    
    // Assignment Submissions (From Dashboard)
    submissions: [{
        assignmentName: String,
        content: String, // The python code or the repl.it link
        status: { type: String, default: 'Pending' }, // Pending, Graded (Passed), Graded (Failed)
        xpAwarded: { type: Number, default: 0 },
        submittedAt: { type: Date, default: Date.now }
    }],
    
    // Completed Quizzes (To prevent playing the same level for infinite XP)
    completedNodes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Mission' }]
}, { timestamps: true });

const User = mongoose.model('User', userSchema);

// 2. Mission (Quiz Pack) Schema
const missionSchema = new mongoose.Schema({
    title: { type: String, required: true }, // e.g., "Operation: Python Loops"
    totalXpPool: { type: Number, required: true },
    isActive: { type: Boolean, default: true },
    
    questions: [{
        questionText: { type: String, required: true },
        options: [{ type: String, required: true }], // Array of 4 strings (A, B, C, D)
        correctIndex: { type: Number, required: true }, // 0, 1, 2, or 3
        xpReward: { type: Number, default: 20 }
    }]
}, { timestamps: true });

const Mission = mongoose.model('Mission', missionSchema);

// 3. Web Dev Order Schema
const orderSchema = new mongoose.Schema({
    fullName: { type: String, required: true },
    whatsapp: { type: String, required: true },
    email: { type: String, required: true },
    projectBrief: { type: String, required: true },
    estimatedPrice: { type: Number, required: true }, // Captures the calculator's output
    status: { type: String, default: 'Pending Review' } // Pending Review, Contacted, Developing, Delivered
}, { timestamps: true });

const Order = mongoose.model('Order', orderSchema);


// ---------------------------------------------------------
// SECURITY MIDDLEWARE
// ---------------------------------------------------------
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Extract token from "Bearer <token>"
    
    if (!token) return res.status(401).json({ message: "Access Denied. No commlink token." });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ message: "Invalid or expired token. Re-authenticate." });
        req.user = user; // Attaches the user's ID to the request
        next();
    });
};


// ---------------------------------------------------------
// 1. AUTHENTICATION ROUTES (Register & Login)
// ---------------------------------------------------------

// Register Student
app.post('/api/auth/register', async (req, res) => {
    try {
        const { fullName, whatsapp, email, username, password } = req.body;

        // Check for duplicates
        const existingUser = await User.findOne({ $or: [{ email }, { username }] });
        if (existingUser) return res.status(400).json({ message: "Alias or Email already active in the system." });

        // Encrypt the password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        // Save to Database
        const newUser = new User({ fullName, whatsapp, email, username, password: hashedPassword });
        await newUser.save();

        res.status(201).json({ message: "Profile initialized successfully." });
    } catch (error) {
        res.status(500).json({ message: "System failure during registration.", error: error.message });
    }
});

// Login Student
app.post('/api/auth/login', async (req, res) => {
    try {
        const { loginId, password } = req.body;
        const user = await User.findOne({ $or: [{ email: loginId }, { username: loginId }] });
        
        if (!user) return res.status(400).json({ message: "Invalid credentials." });

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ message: "Invalid credentials." });

        // Generate Digital ID Card (Valid for 7 days)
        const token = jwt.sign({ userId: user._id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
        res.status(200).json({ token, username: user.username });
    } catch (error) {
        res.status(500).json({ message: "Login failed.", error: error.message });
    }
});


// ---------------------------------------------------------
// 2. STUDENT TERMINAL ROUTES
// ---------------------------------------------------------

// Fetch Dashboard Telemetry (Includes dynamic Global Rank)
app.get('/api/student/dashboard', authenticateToken, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId).select('-password');
        // Count how many users have STRICTLY MORE XP to dynamically determine global rank
        const rank = await User.countDocuments({ xp: { $gt: user.xp } }) + 1; 
        
        res.status(200).json({ user, globalRank: rank });
    } catch (error) {
        res.status(500).json({ message: "Failed to fetch dashboard telemetry." });
    }
});

// Submit Written Assignment (From dashboard.html)
app.post('/api/student/submit', authenticateToken, async (req, res) => {
    try {
        const { assignmentName, content } = req.body;
        const user = await User.findById(req.user.userId);

        user.submissions.push({
            assignmentName: assignmentName,
            content: content
        });

        await user.save();
        res.status(200).json({ message: "Data successfully transmitted to Instructor Mainframe." });
    } catch (error) {
        res.status(500).json({ message: "Transmission failed." });
    }
});


// ---------------------------------------------------------
// 3. GAMIFIED QUIZ ARENA ROUTES
// ---------------------------------------------------------

// Fetch Mission Map (List of all topics/quizzes)
app.get('/api/student/missions', authenticateToken, async (req, res) => {
    try {
        // Fetch all active missions, but hide the 'correctIndex' so students can't cheat by checking the network tab!
        const missions = await Mission.find({ isActive: true }).select('-questions.correctIndex');
        const user = await User.findById(req.user.userId);
        
        res.status(200).json({ 
            missions: missions,
            completedMissionIds: user.completedNodes // Tells frontend which nodes to mark as green/completed
        });
    } catch (error) {
        res.status(500).json({ message: "Failed to load mission map." });
    }
});

// Submit Quiz Result (When they survive the 3-lives system)
app.post('/api/student/missions/complete', authenticateToken, async (req, res) => {
    try {
        const { missionId, xpEarned } = req.body;
        const user = await User.findById(req.user.userId);

        // Anti-cheat: Check if they already beat this exact level
        if (user.completedNodes.includes(missionId)) {
            return res.status(400).json({ message: "Mission already completed. No duplicate XP awarded." });
        }

        user.xp += xpEarned;
        user.completedNodes.push(missionId);
        await user.save();

        res.status(200).json({ message: "XP logged successfully.", newTotalXp: user.xp });
    } catch (error) {
        res.status(500).json({ message: "Failed to sync XP with mainframe." });
    }
});


// ---------------------------------------------------------
// 4. INSTRUCTOR ADMIN ROUTES
// ---------------------------------------------------------

// Get Master Grading List (All students and their submissions)
app.get('/api/admin/students', async (req, res) => {
    try {
        const students = await User.find().select('-password').sort({ xp: -1 }); // Sorted by highest XP
        res.status(200).json(students);
    } catch (error) {
        res.status(500).json({ message: "Failed to fetch master list." });
    }
});

// Grade Assignment (Admin Override from admin.html)
app.post('/api/admin/grade', async (req, res) => {
    try {
        const { studentId, submissionId, xpToAward, isCorrect } = req.body;
        const student = await User.findById(studentId);

        if (!student) return res.status(404).json({ message: "Student not found." });

        // Update Student Global Stats
        student.xp += Number(xpToAward);
        if (isCorrect) student.missionsCompleted += 1;

        // Find the specific submission and update its status
        const sub = student.submissions.id(submissionId);
        if (sub) {
            sub.status = isCorrect ? 'Graded (Passed)' : 'Graded (Failed)';
            sub.xpAwarded = Number(xpToAward);
        }

        // Auto-update accuracy percentage based on total submissions vs passed missions
        const totalSubmissions = student.submissions.length || 1; 
        student.accuracy = Math.round((student.missionsCompleted / totalSubmissions) * 100);

        await student.save();
        res.status(200).json({ message: "Student successfully graded." });
    } catch (error) {
        res.status(500).json({ message: "Grading system error.", error: error.message });
    }
});

// Deploy New Mission (From Mission Builder / CSV Upload)
app.post('/api/admin/missions/deploy', async (req, res) => {
    try {
        const { title, totalXpPool, questionsArray } = req.body;
        
        const newMission = new Mission({
            title: title,
            totalXpPool: totalXpPool,
            questions: questionsArray
        });

        await newMission.save();
        res.status(201).json({ message: "Node Deployed! Mission is now live." });
    } catch (error) {
        res.status(500).json({ message: "Failed to deploy mission node." });
    }
});


// ---------------------------------------------------------
// 5. WEB DEV STUDIO ROUTES (Client Orders)
// ---------------------------------------------------------

// Submit a new Web Development Order
app.post('/api/orders/new', async (req, res) => {
    try {
        const { fullName, whatsapp, email, projectBrief, estimatedPrice } = req.body;

        const newOrder = new Order({
            fullName,
            whatsapp,
            email,
            projectBrief,
            estimatedPrice
        });

        await newOrder.save();
        res.status(201).json({ message: "Project brief successfully transmitted to Studio." });
    } catch (error) {
        res.status(500).json({ message: "Failed to process project brief.", error: error.message });
    }
});


// ---------------------------------------------------------
// SERVER IGNITION
// ---------------------------------------------------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`🚀 Sasta Programmer Matrix Online on Port ${PORT}`);
});