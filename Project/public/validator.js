const Joi = require('joi');

// We use basic string validation for emails instead of .email() 
// because your seeded database users use short usernames like 'admin' and 'manager1'
const loginSchema = Joi.object({
    email: Joi.string().required(),
    password: Joi.string().required(),
    role: Joi.string().valid('admin', 'manager', 'intern').required()
});

const createInternSchema = Joi.object({
    name: Joi.string().min(2).max(100).required(),
    email: Joi.string().required(), 
    role: Joi.string().required(),
    manager: Joi.string().required()
});

const assignTaskSchema = Joi.object({
    internEmail: Joi.string().required(),
    title: Joi.string().min(2).required()
});

const updateScoreSchema = Joi.object({
    title: Joi.string().required(),
    // Accepts a number between 0-100, a dash, an empty string, or null
    score: Joi.alternatives().try(
        Joi.number().integer().min(0).max(100),
        Joi.string().valid('-', ''),
        Joi.valid(null)
    ).required(),
    feedback: Joi.string().allow('', null).optional()
});

const updateStatusSchema = Joi.object({
    status: Joi.string().valid('Pending', 'In Progress', 'Completed').required()
});

// The actual middleware function that intercepts the request
const validateRequest = (schema) => {
    return (req, res, next) => {
        const { error } = schema.validate(req.body, { abortEarly: false });
        
        if (error) {
            const errorMessage = error.details.map(detail => detail.message).join(', ');
            return res.status(400).json({ message: `Validation Error: ${errorMessage}` });
        }
        
        next();
    };
};

module.exports = {
    loginSchema,
    createInternSchema,
    assignTaskSchema,
    updateScoreSchema,
    updateStatusSchema,
    validateRequest
};