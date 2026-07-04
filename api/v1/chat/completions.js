const OPENCODE_URL = "https://opencode.ai/zen/v1/chat/completions";
const CHUB_URL = "https://gateway.chub.ai/v1/chat/completions";
const ALLOWED_MODELS = ["mimo-v2.5-free", "deepseek-v4-flash-free", "nemotron-3-ultra-free", "north-mini-code-free", "mythomax"];

const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
    "Access-Control-Max-Age": "86400"
};

const KEYS = [
    process.env.OPENCODE_KEY_1, process.env.OPENCODE_KEY_2, process.env.OPENCODE_KEY_3,
    process.env.OPENCODE_KEY_4, process.env.OPENCODE_KEY_5, process.env.OPENCODE_KEY_6,
    process.env.OPENCODE_KEY_7, process.env.OPENCODE_KEY_8, process.env.OPENCODE_KEY_9
].filter(Boolean);

const CHUB_KEYS = [process.env.CHUB_KEY_1, process.env.CHUB_KEY_2].filter(Boolean);

export default async function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
    if (req.method === "GET") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ status: "ok" })); }
    if (req.method !== "POST") { res.writeHead(405, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: { message: "Method not allowed" } })); }

    let body;
    try {
        body = await new Promise((resolve) => {
            let data = "";
            req.on("data", c => data += c);
            req.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
        });
    } catch { body = null; }

    if (!body || !ALLOWED_MODELS.includes(body.model)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "Unsupported model", allowed_models: ALLOWED_MODELS } }));
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "messages must be non-empty" } }));
    }

    body.messages.push({ role: "user", content: "[System: You must reason and think ONLY in English. Never use Chinese or any non-English language in your internal reasoning or reasoning_content.]" });
    if (body.temperature !== undefined) body.temperature = Math.min(Math.max(0, Number(body.temperature) || 0), 2);
    if (body.top_p !== undefined) body.top_p = Math.min(Math.max(0, Number(body.top_p) || 1), 1);

    const isChub = body.model === "mythomax";
    const clean = { model: isChub ? "mobile" : body.model, messages: body.messages };
    if (body.stream !== undefined) clean.stream = body.stream;
    if (body.temperature !== undefined) clean.temperature = body.temperature;
    if (body.top_p !== undefined) clean.top_p = body.top_p;
    clean.max_tokens = Math.floor(Number(body.max_tokens) || 32768);

    const apiUrl = isChub ? CHUB_URL : OPENCODE_URL;
    const keys = isChub ? CHUB_KEYS : KEYS;
    if (keys.length === 0) { res.writeHead(500, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: { message: "No API keys configured" } })); }

    let lastError, upstreamRes = null;
    for (let i = 0; i < keys.length; i++) {
        try {
            const headers = { "Content-Type": "application/json" };
            if (isChub) { headers["samwise"] = keys[i]; headers["CH-API-KEY"] = keys[i]; }
            else headers["Authorization"] = `Bearer ${keys[i]}`;
            upstreamRes = await fetch(apiUrl, { method: "POST", headers, body: JSON.stringify(clean) });
            if (upstreamRes.status === 200) break;
            const errText = await upstreamRes.text();
            lastError = `${upstreamRes.status} (key ${i + 1}/${keys.length}): ${errText}`;
            if (upstreamRes.status !== 429 && upstreamRes.status !== 503 && upstreamRes.status !== 402) break;
            upstreamRes = null;
            await new Promise(r => setTimeout(r, 300));
        } catch (err) { lastError = err.message; upstreamRes = null; }
    }

    if (!upstreamRes || upstreamRes.status !== 200) {
        let msg = lastError || "Upstream unavailable";
        try { const p = JSON.parse(msg); msg = p.error?.message || p.message || msg; } catch {}
        res.writeHead(502, { ...CORS, "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: { message: msg } }));
    }

    if (body.stream) {
        res.writeHead(200, { ...CORS, "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
        const { Readable } = require("stream");
        Readable.fromWeb(upstreamRes.body).pipe(res);
    } else {
        const text = await upstreamRes.text();
        res.writeHead(200, { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(text);
    }
}
