const express = require('express');
const app = express();
const dotenv = require('dotenv');
dotenv.config();
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

const xlsx = require('xlsx');
const nodemailer = require('nodemailer');
const schedule = require('node-schedule');

// 1. Configure the email transporter
const transporter = nodemailer.createTransport({
    service: 'gmail', // Or 'outlook' etc.
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

const redis = require('redis'); // Remote Dictionary Server

// 1. Initialize Redis Client
const redisClient = redis.createClient({ url: 'redis://127.0.0.1:6379' });
redisClient.connect().catch(console.error);

const amqp = require('amqplib'); // Advanced Message Queuing Protocol Library
let channel;

// 1. Connect to RabbitMQ and create a queue named "email_tasks"
async function connectRabbitMQ() {
    const connection = await amqp.connect('amqp://localhost');
    channel = await connection.createChannel();
    await channel.assertQueue('email_tasks');
    console.log("RabbitMQ connected and queue created.");
}
connectRabbitMQ();

const { 
    loginSchema, 
    createInternSchema, 
    assignTaskSchema, 
    updateScoreSchema, 
    updateStatusSchema, 
    validateRequest 
} = require('./validators');

// Imported custom configurations 
const requestMonitor = require("./lib/request-monitor.js");

var env = process.env.NODE_ENV || "development";
const appConfig = require("./config/settings.json")[env];

app.set('view engine', 'pug');
app.set('views', path.join(__dirname, 'views')); // Tells Express where to find the templates

// Let Express serve static files (like your toast.css, toast.js, and images)
app.use(express.static(path.join(__dirname, 'public')));

// NEW MIDDLEWARE PIPELINE

// Helmet secures Express apps by setting various HTTP headers
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],

            // Allows your local scripts, inline script blocks, and the jQuery CDN
            scriptSrc: [
                "'self'", 
                "'unsafe-inline'", 
                "https://code.jquery.com",
                "https://cdn.datatables.net", // Allows DataTables JS
             // "https://cdn.jsdelivr.net",    // Allows Chart.js
                "https://cdnjs.cloudflare.com" // Allows Select2, jQuery UI, and Viewer.js
            ],
                
            // Allows inline event handlers like onclick="" and onsubmit=""
            scriptSrcAttr: ["'unsafe-inline'"], 
            
            styleSrc: [
                "'self'", 
                "'unsafe-inline'", 
                "https://cdn.datatables.net",  // Allows DataTables CSS
                "https://cdnjs.cloudflare.com" // <-- ADD THIS LINE
            ],

            // Allows local images and images from Unsplash
            imgSrc: [
                "'self'", 
                "data:", 
                "https://images.unsplash.com",
                "https://cdnjs.cloudflare.com"
            ],

            // Allows connecting to your local API
            connectSrc: [
                "'self'",
             // "https://cdn.jsdelivr.net"
            ]
        }
    }
}));

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
    windowMs: 3 * 60 * 1000, // 3 minutes
    max: 3,                   // Limit
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

// 2. Initialize Sequelize
const sequelize = new Sequelize(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASSWORD, {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    dialect: 'postgres',
    logging: false 
});

sequelize.authenticate()
    .then(() => console.log("Sequelize Full ORM connected successfully"))
    .catch((err) => console.log("Error connecting with DB:", err.message));

// 3. DEFINE SEQUELIZE MODELS (Tables)
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

// 4. DEFINE ASSOCIATIONS (Relationships / Joins)
User.hasOne(Intern, { foreignKey: 'intern_id' });
Intern.belongsTo(User, { foreignKey: 'intern_id' });

Intern.belongsTo(User, { as: 'Manager', foreignKey: 'manager_id' });

User.hasMany(Task, { foreignKey: 'intern_id' });
Task.belongsTo(User, { foreignKey: 'intern_id' });

sequelize.sync({ alter: true })
.then(() => console.log("Database tables synced successfully!"))
.catch((err) => console.log("Error syncing tables:", err));

// MIDDLEWARE: VERIFY JWT (USING COOKIES)
function authToken(req, res, next) {

    const token = req.cookies.token;

    if (!token) return res.status(401).json({ message: 'No token, Access Denied!' });

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => { 
        if (err) return res.status(403).json({ message: 'Invalid Token' });
        req.user = user;
        next();
    });
}

// DB SEED ROUTE
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

// 1. AUTHENTICATION (Login & Logout)
app.post('/login', limiter, validateRequest(loginSchema), async (req, res) => {
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

// 2. DATA FETCHING (Protected)
app.get('/api/interns', authToken, async (req, res) => { 
    try {
        // 2. CHECK CACHE FIRST: Do we already have the interns data in Redis?
        const cachedData = await redisClient.get('all_interns_data');

        if (cachedData){
            console.log("Cache Hit! Serving from Redis instantly.");
            return res.status(200).json(JSON.parse(cachedData));
        }
        
        // 3. If no cache, query PostgreSQL as usual
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

        // 4. SAVE TO CACHE: Store the result in Redis for 10 minutes (600 seconds)
        await redisClient.setEx('all_interns_data', 600, JSON.stringify(formattedData));

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

/*
app.put('/api/interns/:id/promote', authToken, async (req, res) => {
    try {
        const user = await User.findByPk(req.params.id);
        if (!user) return res.status(404).json({ error: "User not found" });

        const tasks = await user.getTasks(); 
        user.role = 'employee'; 
        await user.save(); 

        await redisClient.del('all_interns_data');
        
        res.json({ message: "Intern successfully promoted!", updatedUser: user, assignedTasks: tasks });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});
*/

// 3. ADMIN ENDPOINTS (Protected)
app.post('/api/interns', authToken, validateRequest(createInternSchema), async (req, res) => {
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

        await redisClient.del('all_interns_data');
        
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
        
        await redisClient.del('all_interns_data');

        res.status(200).json({ message: 'Intern deleted' });
    } catch (err) {
        console.log(err.stack);
        res.status(500).json({ message: "Internal server error" });
    }
});

/*
app.post('/api/tasks', authToken, async (req, res) => {
    try {
        const { internEmail, title } = req.body;
        
        const user = await User.findOne({ where: { email: internEmail } });
        if (!user) return res.status(404).json({ message: "Intern not found" });

        // Save to DB
        await Task.create({ intern_id: user.user_id, title });
        
        await redisClient.del('all_interns_data');
        
        // 3. Send the notification email
        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: internEmail,
            subject: 'New Task Assigned: KTT Intern Portal',
            html: `<h3>Hello ${user.name},</h3>
                   <p>Your manager has assigned you a new task:</p>
                   <p><strong>${title}</strong></p>
                   <p>Please log in to your dashboard to update your progress.</p>`
        };

        // We use .sendMail() but don't await it so the frontend doesn't freeze waiting for the email to send
        transporter.sendMail(mailOptions).catch(err => console.log('Email failed:', err));

        res.status(201).json({ message: 'Task assigned and intern notified' });
    } catch (err) {
        res.status(500).json({ message: "Internal server error" });
    }
});
*/

// 4. MANAGER & TASK ENDPOINTS (Protected)

app.post('/api/tasks', authToken, validateRequest(assignTaskSchema), async (req, res) => {
    try {
        const { internEmail, title } = req.body;
        
        const user = await User.findOne({ where: { email: internEmail } });
        if (!user) return res.status(404).json({ message: "Intern not found" });

        await Task.create({ intern_id: user.user_id, title });
        await redisClient.del('all_interns_data'); // Clear cache

        // 2. Drop the email job into RabbitMQ instead of sending it here!
        const emailJob = { email: internEmail, name: user.name, title: title };
        channel.sendToQueue('email_tasks', Buffer.from(JSON.stringify(emailJob)));

        // Respond instantly instead of waiting for the SMTP server
        res.status(201).json({ message: 'Task assigned successfully' });
    } catch (err) {
        res.status(500).json({ message: "Internal server error" });
    }
});


// 3. The Worker: Listens to the queue continuously and sends emails
async function startEmailWorker() {
    // Wait a few seconds for the RabbitMQ connection to establish
    setTimeout(() => {
        channel.consume('email_tasks', async (msg) => {
            if (msg !== null) {
                const jobData = JSON.parse(msg.content.toString());
                
                const mailOptions = {
                    from: process.env.EMAIL_USER,
                    to: jobData.email,
                    subject: 'New Task Assigned',
                    html: `<h3>Hello ${jobData.name},</h3><p>New Task: ${jobData.title}</p>`
                };

                try {
                    await transporter.sendMail(mailOptions); // Wait for Nodemailer here
                    console.log(`Email successfully sent to ${jobData.email} via RabbitMQ Worker!`);
                    
                    // Tell RabbitMQ we finished the job so it can remove it from the queue
                    channel.ack(msg); 
                } catch (error) {
                    console.log("Worker failed to send email", error);
                }
            }
        });
    }, 5000);
}
startEmailWorker();


schedule.scheduleJob('0 9 * * *', async () => {
    console.log('Running daily automated task reminder check...');

    try {
        // 1. Find all pending tasks and include the User data to get their email
        const pendingTasks = await Task.findAll({
            where: { status: 'Pending' },
            include: [{ model: User, attributes: ['name', 'email'] }]
        });

        if (pendingTasks.length === 0) {
            return console.log('No pending tasks found today.');
        }

        // 2. Loop through pending tasks and send reminder emails
        for (const task of pendingTasks) {
            const mailOptions = {
                from: process.env.EMAIL_USER,
                to: task.User.email,
                subject: 'Action Required: Pending Task Reminder',
                html: `<h3>Hello ${task.User.name},</h3>
                       <p>This is an automated reminder that you have a task marked as <strong>Pending</strong>.</p>
                       <p><strong>Task:</strong> ${task.title}</p>
                       <p>Please update your status on the portal as soon as possible.</p>`
            };

            // 3. Detailed sending block INSIDE the loop
            try {
                const info = await transporter.sendMail(mailOptions);
                console.log(`Success! Google accepted the email for ${task.User.email} with response:`, info.response);
            } catch (error) {
                console.error(`SMTP Error for ${task.User.email}:`, error);
            }
        }
        
        console.log(`Finished processing ${pendingTasks.length} reminder emails.`);

    } catch (err) {
        console.error('Error running daily cron job:', err);
    }
});

app.put('/api/tasks/:id/score', authToken, validateRequest(updateScoreSchema), async (req, res) => {
    try {
        const { title, score, feedback } = req.body;
        const parsedScore = (score === '-' || score === '') ? null : score;

        await Task.update(
            { title, score: parsedScore, feedback }, 
            { where: { task_id: req.params.id } }
        );

        await redisClient.del('all_interns_data');
        
        res.status(200).json({ message: 'Score saved' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/tasks/:id', authToken, async (req, res) => {
    try {
        await Task.destroy({ where: { task_id: req.params.id } });

        await redisClient.del('all_interns_data');

        res.status(200).json({ message: 'Task Deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/tasks/:id/status', authToken, validateRequest(updateStatusSchema), async (req, res) => {
    try {
        await Task.update(
            { status: req.body.status }, 
            { where: { task_id: req.params.id } }
        );

        await redisClient.del('all_interns_data');
        
        res.status(200).json({ message: 'Status Updated' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/export/interns', authToken, async (req, res) => {
    try {
        // 1. Fetch all interns and their tasks from PostgreSQL
        const internsData = await User.findAll({
            where: { role: 'intern' },
            include: [
                { model: Intern, required: true, include: [{ model: User, as: 'Manager' }] },
                { model: Task, required: false }
            ]
        });

        // 2. Format the data for Excel
        const excelData = [];
        internsData.forEach(user => {
            if (user.Tasks.length === 0) {
                excelData.push({ Name: user.name, Email: user.email, Manager: user.Intern.Manager.name, Task: 'No Task', Status: 'N/A', Score: 'N/A' });
            } else {
                user.Tasks.forEach(task => {
                    excelData.push({ Name: user.name, Email: user.email, Manager: user.Intern.Manager.name, Task: task.title, Status: task.status, Score: task.score || '-' });
                });
            }
        });

        // 3. Create the Excel workbook and sheet
        const worksheet = xlsx.utils.json_to_sheet(excelData);
        const workbook = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(workbook, worksheet, "Intern Progress");

        // 4. Convert to a buffer and send as a downloadable file
        const buffer = xlsx.write(workbook, { bookType: 'xlsx', type: 'buffer' });
        
        res.setHeader('Content-Disposition', 'attachment; filename="intern_report.xlsx"');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buffer);

    } catch (err) {
        res.status(500).json({ message: 'Error generating Excel file' });
    }
});

// 1. Root route - sends login page
app.get('/', (req, res) => {
    res.render('login'); 
});

// 2. Protected Admin Route
app.get('/admin', authToken, (req, res) => {
    // Server checks if the logged-in user is actually an admin
    if (req.user.role !== 'admin') {
        return res.status(403).redirect('/'); // Instantly bounces them back
    }
    res.render('admin'); 
});

// 3. Protected Manager Route
app.get('/manager', authToken, (req, res) => {
    if (req.user.role !== 'manager') {
        return res.status(403).redirect('/');
    }
    res.render('manager');
});

// 4. Protected Intern Route
app.get('/intern', authToken, (req, res) => {
    if (req.user.role !== 'intern') {
        return res.status(403).redirect('/');
    }
    res.render('intern');
});

const PORT = process.env.PORT || appConfig.port || 3000;
app.listen(PORT, () => {
    console.log(`${appConfig.appName} is running on port ${PORT} in [${env}] mode`);
});