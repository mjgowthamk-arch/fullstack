const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const { Sequelize, DataTypes } = require('sequelize'); 
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const path = require('path');
const favicon = require('serve-favicon');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const bodyParser = require('body-parser');
const compression = require('compression');
const { v4: uuidv4 } = require('uuid');
const helmet = require('helmet');
const rateLimit = require("express-rate-limit");

// Imported custom configurations 

const requestMonitor = require("./lib/request-monitor.js");

var env = process.env.NODE_ENV || "development";
const appConfig = require("./config/settings.json")[env];


dotenv.config();
const app = express();

// ==========================================
// NEW MIDDLEWARE PIPELINE
// ==========================================

// Helmet secures Express apps by setting various HTTP headers
app.use(helmet());

// Compression shrinks the size of the response bodies sent to the frontend
app.use(compression());

// Morgan logs every incoming HTTP request to the terminal
app.use(morgan('dev'));

// Cookie Parser allows Express to read req.cookies.token
app.use(cookieParser());

// Replaced app.use(express.json()) with explicit Body Parser config
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Configured CORS to accept cookies from the frontend
app.use(cors({
    origin: 'http://127.0.0.1:5500', // Must perfectly match your frontend URL to allow cookies
    credentials: true  // Allows the browser to send the HttpOnly cookie
}));

// Express Rate Limit prevents brute-force / DDoS attacks
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5,                   // Limit each IP to 100 requests per window
    handler: (req, res) => {
        res.status(429).json({ message: "Too many requests from this IP, please try again after 15 minutes" }); // 429 Too Many Requests
    }
});


// UUID Middleware to assign a unique ID to every incoming request for tracing
app.use((req, res, next) => {
    req.requestId = uuidv4();
    next();
});

// Custom request monitor 
app.use(requestMonitor);

// Favicon serving 
app.use(favicon(path.join(__dirname, 'public', 'favicon.ico')));

// ==========================================
// 2. Initialize Sequelize
// ==========================================
const sequelize = new Sequelize(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASSWORD, {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    dialect: 'postgres',
    logging: false 
});

sequelize.authenticate()
    .then(() => console.log("Sequelize Full ORM connected successfully"))
    .catch((err) => console.log("Error connecting with DB:", err.message));

// ==========================================
// 3. DEFINE SEQUELIZE MODELS (Tables)
// ==========================================

const User = sequelize.define('User', {
    user_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING, allowNull: false },
    email: { type: DataTypes.STRING, unique: true, allowNull: false },
    password: { type: DataTypes.STRING, allowNull: false },
    role: { type: DataTypes.STRING, allowNull: false }
}, { tableName: 'users', timestamps: false });

const Intern = sequelize.define('Intern', {
    intern_id: { type: DataTypes.INTEGER, primaryKey: true },
    designation: { type: DataTypes.STRING },
    manager_id: { type: DataTypes.INTEGER }
}, { tableName: 'interns', timestamps: false });

const Task = sequelize.define('Task', {
    task_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    intern_id: { type: DataTypes.INTEGER },
    title: { type: DataTypes.STRING, allowNull: false },
    status: { type: DataTypes.STRING, defaultValue: 'Pending' },
    score: { type: DataTypes.INTEGER, allowNull: true },
    feedback: { type: DataTypes.TEXT, allowNull: true },
    assigned_date: { type: DataTypes.DATE, defaultValue: Sequelize.NOW }
}, { tableName: 'tasks', timestamps: false });

// ==========================================
// 4. DEFINE ASSOCIATIONS (Relationships / Joins)
// ==========================================

User.hasOne(Intern, { foreignKey: 'intern_id' });
Intern.belongsTo(User, { foreignKey: 'intern_id' });

Intern.belongsTo(User, { as: 'Manager', foreignKey: 'manager_id' });

User.hasMany(Task, { foreignKey: 'intern_id' });
Task.belongsTo(User, { foreignKey: 'intern_id' });

sequelize.sync({ alter: true })
.then(() => console.log("Database tables synced successfully!"))
.catch((err) => console.log("Error syncing tables:", err));


// ==========================================
// MIDDLEWARE: VERIFY JWT (USING COOKIES)
// ==========================================
function authToken(req, res, next) {

    const token = req.cookies.token;

    if (!token) return res.status(401).json({ message: 'No token, Access Denied!' });

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => { 
        if (err) return res.status(403).json({ message: 'Invalid Token' });
        req.user = user;
        next();
    });
}

// ==========================================
// DB SEED ROUTE
// ==========================================
app.get('/seed', async (req, res) => {
    try {
        const hashedPass = await bcrypt.hash('123', 10);
        await User.destroy({ truncate: true, cascade: true });
        
        await User.bulkCreate([
            { name: 'HR Admin', email: 'admin', password: hashedPass, role: 'admin' },
            { name: 'Manager 1', email: 'manager1', password: hashedPass, role: 'manager' },
            { name: 'Manager 2', email: 'manager2', password: hashedPass, role: 'manager' }
        ]);

        res.status(200).json({ message: 'Database seeded successfully!' });
    } catch (err) {
        console.log(err.stack);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// ==========================================
// 1. AUTHENTICATION (Login & Logout)
// ==========================================
app.post('/login', limiter, async (req, res) => {
    try {
        const { email, password, role } = req.body;
        
        const user = await User.findOne({ where: { email, role } });

        if (!user) return res.status(401).json({ message: 'Invalid credentials' });

        const validPass = await bcrypt.compare(password, user.password);
        if (!validPass) return res.status(401).json({ message: 'Invalid credentials' });

        const userData = user.toJSON(); 

        if (userData.role === 'intern') {
            const internDetails = await Intern.findOne({ where: { intern_id: userData.user_id } });
            userData.designation = internDetails ? internDetails.designation : '';
        }

        const payload = { user_id: userData.user_id, email: userData.email, role: userData.role };
        const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '8h' });
        delete userData.password;

        // We send the token securely via an HttpOnly cookie, NOT in the JSON body
        res.cookie('token', token, {
            httpOnly: true,                                // Prevents XSS attacks (Frontend JS cannot read it)
            secure: process.env.NODE_ENV === 'production', // Only transmits the cookie over HTTPS in production
            sameSite: 'lax',                               // Protects against CSRF attacks by controlling cross-site requests
            path: '/',                                     // Makes the cookie accessible to all routes on your backend
            maxAge: 8 * 60 * 60 * 1000                     // Sets cookie lifespan (8 hours in milliseconds)
        });

        res.status(200).json({ message: 'Login successful', user: userData });

    } catch (err) {
        console.log(err.stack);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Logout route to destroy the cookie
app.post('/logout', (req, res) => {
    res.clearCookie('token');
    res.status(200).json({ message: 'Logged out successfully' });
});

// ==========================================
// 2. DATA FETCHING (Protected)
// ==========================================
app.get('/api/interns', authToken, async (req, res) => { 
    try {
        const internsData = await User.findAll({
            where: { role: 'intern' },
            include: [
                {
                    model: Intern,
                    required: true,
                    include: [{ model: User, as: 'Manager', attributes: ['name'] }]
                },
                {
                    model: Task,
                    required: false
                }
            ]
        });

        const formattedData = internsData.map((u) => {
            return {
                name: u.name,
                email: u.email,
                role: u.Intern.designation,
                manager: u.Intern.Manager.name,
                tasks: u.Tasks.map(t => {
                    return {
                        id: t.task_id,
                        title: t.title,
                        status: t.status,
                        score: t.score === null ? '-' : t.score,
                        feedback: t.feedback || '',
                        assignedDate: new Date(t.assigned_date).toLocaleDateString('en-GB')
                    };
                })
            };
        });

        res.status(200).json(formattedData);

    } catch (err) {
        console.log(err.stack);
        res.status(500).json({ message: 'Internal server error' });
    }
});

app.get('/api/users/:id', authToken, async (req, res) => {
    try {
        const user = await User.findByPk(req.params.id);
        if (!user) return res.status(404).json({ error: "User not found" });
        res.json(user);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/interns/:id/promote', authToken, async (req, res) => {
    try {
        const user = await User.findByPk(req.params.id);
        if (!user) return res.status(404).json({ error: "User not found" });

        const tasks = await user.getTasks(); 
        user.role = 'employee'; 
        await user.save(); 

        res.json({ message: "Intern successfully promoted!", updatedUser: user, assignedTasks: tasks });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// 3. ADMIN ENDPOINTS (Protected)
// ==========================================
app.post('/api/interns', authToken, async (req, res) => {
    const t = await sequelize.transaction();
    try {
        const { name, email, role, manager } = req.body;
        const hashPass = await bcrypt.hash('123', 10);

        const newUser = await User.create(
            { name, email, password: hashPass, role: 'intern' }, 
            { transaction: t }
        );

        const managerData = await User.findOne(
            { where: { name: manager, role: 'manager' } }, 
            { transaction: t }
        );

        await Intern.create(
            { intern_id: newUser.user_id, designation: role, manager_id: managerData.user_id }, 
            { transaction: t }
        );

        await t.commit();
        res.status(201).json({ message: 'Intern created successfully' });
    } catch (err) {
        await t.rollback();
        console.log(err.stack);
        res.status(500).json({ message: 'Internal server error' });
    }
});

app.delete('/api/interns/:email', authToken, async (req, res) => {
    try {
        await User.destroy({ where: { email: req.params.email } });
        res.status(200).json({ message: 'Intern deleted' });
    } catch (err) {
        console.log(err.stack);
        res.status(500).json({ message: "Internal server error" });
    }
});

// ==========================================
// 4. MANAGER & TASK ENDPOINTS (Protected)
// ==========================================
app.post('/api/tasks', authToken, async (req, res) => {
    try {
        const { internEmail, title } = req.body;
        
        const user = await User.findOne({ where: { email: internEmail } });
        if (!user) return res.status(404).json({ message: "Intern not found" });

        await Task.create({ intern_id: user.user_id, title });
        res.status(201).json({ message: 'Task assigned' });
    } catch (err) {
        console.log(err.stack);
        res.status(500).json({ message: "Internal server error" });
    }
});

app.put('/api/tasks/:id/score', authToken, async (req, res) => {
    try {
        const { title, score, feedback } = req.body;
        const parsedScore = (score === '-' || score === '') ? null : score;

        await Task.update(
            { title, score: parsedScore, feedback }, 
            { where: { task_id: req.params.id } }
        );
        res.status(200).json({ message: 'Score saved' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/tasks/:id', authToken, async (req, res) => {
    try {
        await Task.destroy({ where: { task_id: req.params.id } });
        res.status(200).json({ message: 'Task Deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/tasks/:id/status', authToken, async (req, res) => {
    try {
        await Task.update(
            { status: req.body.status }, 
            { where: { task_id: req.params.id } }
        );
        res.status(200).json({ message: 'Status Updated' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || appConfig.port || 3000;
app.listen(PORT, () => {
    console.log(`${appConfig.appName} is running on port ${PORT} in [${env}] mode`);
});