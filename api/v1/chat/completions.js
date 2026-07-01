const OPENCODE_URL = "https://opencode.ai/zen/v1/chat/completions";

const MODELS = {
    "mimo-v2.5-free":          { provider: "opencode", upstream: "mimo-v2.5-free" },
    "deepseek-v4-flash-free":  { provider: "opencode", upstream: "deepseek-v4-flash-free" },
    "nemotron-3-ultra-free":   { provider: "opencode", upstream: "nemotron-3-ultra-free" },
    "north-mini-code-free":    { provider: "opencode", upstream: "north-mini-code-free" }
};

const ALLOWED_MODELS = Object.keys(MODELS);

const SECURITY = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-XSS-Protection": "1; mode=block",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
    "Content-Security-Policy": "default-src 'self'",
    "X-Robots-Tag": "noindex, nofollow"
};

const ipHits = new Map();
const RATE_WINDOW = 60000;
const RATE_MAX = 100;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_MESSAGES = 300;
const MAX_MESSAGE_CHARS = 300000;
const DEFAULT_USAGE = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0
};

function checkRate(ip) {
    const now = Date.now();
    const rec = ipHits.get(ip);
    if (!rec || now - rec.start > RATE_WINDOW) {
        ipHits.set(ip, { start: now, count: 1 });
        if (ipHits.size > 10000) {
            const oldest = ipHits.keys().next().value;
            ipHits.delete(oldest);
        }
        return true;
    }
    rec.count++;
    return rec.count <= RATE_MAX;
}

function getClientIp(req) {
    return req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
           req.headers["x-real-ip"] ||
           "unknown";
}

function json(res, status, data) {
    res.writeHead(status, { ...SECURITY, "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
}

function errorPayload(message, code = "proxy_error") {
    return {
        error: {
            message,
            type: "invalid_request_error",
            code
        }
    };
}

function normalizeContent(value) {
    if (typeof value === "string") {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map((part) => {
            if (typeof part === "string") return part;
            if (part && typeof part === "object") {
                if (typeof part.text === "string") return part.text;
                if (typeof part.content === "string") return part.content;
            }
            return "";
        }).join("");
    }
    return "";
}

function extractReasoningText(msg) {
    const candidates = [
        msg?.reasoning,
        msg?.reasoning_content,
        msg?.refusal
    ];

    if (Array.isArray(msg?.reasoning_details)) {
        candidates.push(msg.reasoning_details.map((part) => {
            if (typeof part === "string") return part;
            if (part && typeof part === "object") {
                return part.text || part.content || part.reasoning || "";
            }
            return "";
        }).join("\n"));
    }

    return candidates
        .map(normalizeContent)
        .find((text) => text.trim().length > 0) || "";
}

function sanitizeMessage(msg) {
    const content = normalizeContent(msg?.content);
    const reasoning = extractReasoningText(msg);
    const safeContent = content.trim().length > 0 ? content : reasoning;

    const message = {
        role: typeof msg?.role === "string" ? msg.role : "assistant",
        content: safeContent
    };

    if (reasoning.trim().length > 0) {
        message.reasoning_content = reasoning;
        message.reasoning = reasoning;
    }

    return message;
}

function normalizeCompletion(out, model) {
    const created = Number.isFinite(out?.created) ? out.created : Math.floor(Date.now() / 1000);
    const requestId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const id = typeof out?.id === "string" && out.id ? out.id : `chatcmpl-${requestId}`;
    const choices = Array.isArray(out?.choices) ? out.choices : [];

    return {
        id,
        object: "chat.completion",
        created,
        model,
        choices: choices.map((choice, index) => ({
            index: Number.isInteger(choice?.index) ? choice.index : index,
            message: sanitizeMessage(choice?.message || {}),
            finish_reason: typeof choice?.finish_reason === "string" ? choice.finish_reason : "stop"
        })),
        usage: {
            ...DEFAULT_USAGE,
            ...(out?.usage && typeof out.usage === "object" ? out.usage : {})
        }
    };
}

function writeSse(res, event) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function chunkText(text, chunkSize) {
    const chunks = [];
    for (let i = 0; i < text.length; i += chunkSize) {
        chunks.push(text.slice(i, i + chunkSize));
    }
    return chunks;
}

async function streamCompletion(res, completion) {
    res.writeHead(200, {
        ...SECURITY,
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store, no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no"
    });

    for (const choice of completion.choices) {
        if (choice.message.reasoning_content) {
            const reasoningChunks = chunkText(choice.message.reasoning_content, 20);
            for (const chunk of reasoningChunks) {
                writeSse(res, {
                    id: completion.id,
                    object: "chat.completion.chunk",
                    created: completion.created,
                    model: completion.model,
                    choices: [{
                        index: choice.index,
                        delta: {
                            role: choice.message.role,
                            reasoning_content: chunk,
                            reasoning: chunk
                        },
                        finish_reason: null
                    }]
                });
                await sleep(5);
            }
        }

        const content = choice.message.content || "";
        if (content) {
            const contentChunks = chunkText(content, 15);
            for (const chunk of contentChunks) {
                writeSse(res, {
                    id: completion.id,
                    object: "chat.completion.chunk",
                    created: completion.created,
                    model: completion.model,
                    choices: [{
                        index: choice.index,
                        delta: { content: chunk },
                        finish_reason: null
                    }]
                });
                await sleep(5);
            }
        }

        writeSse(res, {
            id: completion.id,
            object: "chat.completion.chunk",
            created: completion.created,
            model: completion.model,
            choices: [{
                index: choice.index,
                delta: {},
                finish_reason: choice.finish_reason || "stop"
            }]
        });
    }

    res.write("data: [DONE]\n\n");
    return res.end();
}

function validateMessages(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
        return "messages must be a non-empty array";
    }
    if (messages.length > MAX_MESSAGES) {
        return `messages cannot exceed ${MAX_MESSAGES} items`;
    }
    for (const message of messages) {
        if (!message || typeof message !== "object" || Array.isArray(message)) {
            return "each message must be an object";
        }
        if (typeof message.role !== "string") {
            return "each message.role must be a string";
        }
        const content = normalizeContent(message.content);
        if (content.length > MAX_MESSAGE_CHARS) {
            return `message content cannot exceed ${MAX_MESSAGE_CHARS} characters`;
        }
    }
    return null;
}

export default async function handler(req, res) {

    if (req.method === "OPTIONS") {
        res.writeHead(204, SECURITY);
        return res.end();
    }

    if (req.method === "GET") {
        return json(res, 200, { status: "ok", endpoint: "/v1/chat/completions", method: "POST" });
    }

    if (req.method !== "POST") {
        return json(res, 405, errorPayload("Method not allowed", "method_not_allowed"));
    }

    const ip = getClientIp(req);
    if (!checkRate(ip)) {
        res.writeHead(429, {
            ...SECURITY,
            "Content-Type": "application/json",
            "Retry-After": "60",
            "X-RateLimit-Limit": String(RATE_MAX),
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": String(Math.ceil((Date.now() + RATE_WINDOW) / 1000))
        });
        return res.end(JSON.stringify(errorPayload(`Rate limit exceeded. Max ${RATE_MAX} requests per minute.`, "rate_limit_exceeded")));
    }

    const body = await new Promise((resolve) => {
        let data = "";
        let size = 0;
        let tooLarge = false;
        req.on("data", (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                tooLarge = true;
                return;
            }
            data += chunk;
        });
        req.on("end", () => {
            if (tooLarge) {
                return resolve({ __tooLarge: true });
            }
            try {
                resolve(JSON.parse(data));
            } catch {
                resolve(null);
            }
        });
        req.on("error", () => resolve(null));
    });

    if (body?.__tooLarge) {
        return json(res, 413, errorPayload("Request body too large", "payload_too_large"));
    }

    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return json(res, 400, errorPayload("Invalid JSON", "invalid_json"));
    }

    const wantsStream = body.stream === true;

    if (!body.model || typeof body.model !== "string" || !ALLOWED_MODELS.includes(body.model)) {
        return json(res, 400, {
            error: {
                message: "Unsupported model.",
                type: "invalid_request_error",
                code: "unsupported_model",
                allowed_models: ALLOWED_MODELS
            }
        });
    }

    const messagesError = validateMessages(body.messages);
    if (messagesError) {
        return json(res, 400, errorPayload(messagesError, "invalid_messages"));
    }

    body.messages.push({ role: "user", content: "[System: You must reason and think ONLY in English. Never use Chinese or any non-English language in your internal reasoning or reasoning_content.]" });

    if (body.temperature !== undefined) {
        body.temperature = Math.min(Math.max(0, Number(body.temperature) || 0), 2);
    }
    if (body.top_p !== undefined) {
        body.top_p = Math.min(Math.max(0, Number(body.top_p) || 1), 1);
    }
    if (body.max_tokens !== undefined) {
        body.max_tokens = Math.floor(Number(body.max_tokens) || 4096);
    }

    const clean = { model: body.model, messages: body.messages };
    if (body.stream !== undefined) clean.stream = body.stream;
    if (body.temperature !== undefined) clean.temperature = body.temperature;
    if (body.top_p !== undefined) clean.top_p = body.top_p;
    if (body.max_tokens !== undefined) clean.max_tokens = body.max_tokens;
    Object.keys(body).forEach(k => delete body[k]);
    Object.assign(body, clean);

    const modelInfo = MODELS[body.model];

    body.model = modelInfo.upstream;

    const keys = [
        process.env.OPENCODE_KEY_1,
        process.env.OPENCODE_KEY_2,
        process.env.OPENCODE_KEY_3
    ].filter(Boolean);

    const apiUrl = OPENCODE_URL;

    let response;
    let lastError;
    for (let i = 0; i < keys.length; i++) {
        try {
            response = await fetch(apiUrl, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${keys[i]}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(120000)
            });
            if (response.status !== 429) break;
            lastError = await response.text();
        } catch (err) {
            lastError = err.message;
        }
        if (i < keys.length - 1) response = null;
    }

    if (!response) {
        return json(res, 502, errorPayload("Upstream API unavailable", "upstream_unavailable"));
    }

    if (wantsStream) {
        res.writeHead(200, {
            ...SECURITY,
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-store, no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        });

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                res.write(decoder.decode(value, { stream: true }));
            }
        } catch {}
        return res.end();
    }

    const text = await response.text();

    let out;
    try {
        out = JSON.parse(text);
        if (out.error?.message) {
            delete out.metadata;
            delete out.request_id;
            out.error.type ||= "api_error";
            out.error.code ||= "upstream_error";
        }

        if (!out.error) {
            out = normalizeCompletion(out, body.model);
        }
    } catch {
        out = errorPayload("Invalid upstream response", "invalid_upstream_response");
    }

    res.writeHead(response.status, { ...SECURITY, "Content-Type": "application/json", "Cache-Control": "no-store" });
    return res.end(JSON.stringify(out));
}
