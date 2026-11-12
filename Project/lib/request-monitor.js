
module.exports = function(req, res, next) {
    const startTimestamp = Date.now();

    // Listen for when the response finishes sending to the client
    res.on('finish', () => {
        const duration = Date.now() - startTimestamp;
        console.log(`[Request Monitor] ID: ${req.requestId} | ${req.method} ${req.originalUrl} | Status: ${res.statusCode} | Took: ${duration}ms`);
    });

    next();
};