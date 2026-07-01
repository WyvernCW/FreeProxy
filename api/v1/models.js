const ALLOWED_MODELS = [
    "mimo-v2.5-free",
    "deepseek-v4-flash-free",
    "nemotron-3-ultra-free",
    "north-mini-code-free"
];

const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "86400"
};

export default async function handler(req, res) {

    if (req.method === "OPTIONS") {
        res.writeHead(204, CORS);
        return res.end();
    }

    if (req.method !== "GET") {
        res.writeHead(405, { ...CORS, "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "Method not allowed" } }));
    }

    res.writeHead(200, {
        ...CORS,
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300, s-maxage=300",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "X-XSS-Protection": "1; mode=block",
        "Referrer-Policy": "strict-origin-when-cross-origin",
        "Permissions-Policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
        "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
        "Content-Security-Policy": "default-src 'self'",
        "X-Robots-Tag": "noindex, nofollow"
    });

    return res.end(JSON.stringify({
        object: "list",
        data: ALLOWED_MODELS.map(model => ({
            id: model,
            object: "model",
            owned_by: "opencode"
        }))
    }));
}
