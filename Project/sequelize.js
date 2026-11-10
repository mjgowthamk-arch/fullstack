// 1. Import required modules
const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const { Sequelize, DataTypes } = require('sequelize'); 
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

dotenv.config();
const app = express();

app.use(cors());
app.use(express.json());

// 2. Initialize Sequelize
const sequelize = new Sequelize(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASSWORD, {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    dialect: 'postgres',
    logging: console.log 
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

// An Intern profile belongs to a User
User.hasOne(Intern, { foreignKey: 'intern_id' });
Intern.belongsTo(User, { foreignKey: 'intern_id' });


// An Intern also belongs to a Manager (who is just another User)
Intern.belongsTo(User, { as: 'Manager', foreignKey: 'manager_id' });

// A Task belongs to an intern (linked by their user_id)
User.hasMany(Task, { foreignKey: 'intern_id' });
Task.belongsTo(User, { foreignKey: 'intern_id' });


sequelize.sync({ alter: true })
.then(() => console.log("Database tables synced successfully!"))
.catch((err) => console.log("Error syncing tables:", err));

// ==========================================
// MIDDLEWARE: VERIFY JWT
// ==========================================
function authToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

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
        
        // ORM: Truncate table
        await User.destroy({ truncate: true, cascade: true });
        
        // ORM: Bulk Insert
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
// 1. AUTHENTICATION (Login)
// ==========================================
app.post('/login', async (req, res) => {
    try {
        const { email, password, role } = req.body;
        
        // ORM: Find one user
        const user = await User.findOne({ where: { email, role } });

        if (!user) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        const validPass = await bcrypt.compare(password, user.password);
        if (!validPass) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        // Convert the Sequelize object to a plain JSON object so we can modify it
        const userData = user.toJSON(); 

        if (userData.role === 'intern') {
            // ORM: Find intern details
            const internDetails = await Intern.findOne({ where: { intern_id: userData.user_id } });
            userData.designation = internDetails ? internDetails.designation : '';
        }

        const payload = {
            user_id: userData.user_id,
            email: userData.email,
            role: userData.role
        };

        const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '8h' });
        delete userData.password;

        res.status(200).json({ message: 'Login successful', token, user: userData });

    } catch (err) {
        console.log(err.stack);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// ==========================================
// 2. DATA FETCHING (Protected)
// ==========================================
app.get('/api/interns', async (req, res) => {
    try {
        // ORM: The equivalent of your massive INNER JOIN query!
        // Sequelize automatically joins the tables based on the Associations we defined at the top.
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

        // Format the nested Sequelize output to match your frontend exactly
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


// Route: Get a single user by Primary Key
app.get('/api/users/:id', async (req, res) => {
    try {
        const user = await User.findByPk(req.params.id);
        if (!user) return res.status(404).json({ error: "User not found" });
        res.json(user);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Route: Promote an intern using Lazy Loading and .save()
app.put('/api/interns/:id/promote', async (req, res) => {
    try {
        // 1. Find the user by Primary Key
        const user = await User.findByPk(req.params.id);
        if (!user) return res.status(404).json({ error: "User not found" });

        // 2. Lazy load their tasks
        const tasks = await user.getTasks(); 

        // 3. Mutate an EXISTING column
        user.role = 'employee'; 
        
        // 4. Push the change to the database
        await user.save(); 

        res.json({
            message: "Intern successfully promoted to employee!",
            updatedUser: user,
            assignedTasks: tasks 
        });
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

        // ORM: Insert new user
        const newUser = await User.create(
            { name, email, password: hashPass, role: 'intern' }, 
            { transaction: t }
        );

        // ORM: Find the manager's ID
        const managerData = await User.findOne(
            { where: { name: manager, role: 'manager' } }, 
            { transaction: t }
        );

        // ORM: Insert new intern profile
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
        // ORM: Delete user
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

        // ORM: Insert task
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

        // ORM: Update task
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
        // ORM: Delete task
        await Task.destroy({ where: { task_id: req.params.id } });
        res.status(200).json({ message: 'Task Deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/tasks/:id/status', authToken, async (req, res) => {
    try {
        // ORM: Update task status
        await Task.update(
            { status: req.body.status }, 
            { where: { task_id: req.params.id } }
        );
        res.status(200).json({ message: 'Status Updated' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 17. Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));