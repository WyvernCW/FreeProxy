const { onRequest } = require("firebase-functions/v2/https");

const OPENCODE_URL = "https://opencode.ai/zen/v1/chat/completions";
const CHUB_URL = "https://gateway.chub.ai/v1/chat/completions";
const ALLOWED_MODELS = ["mimo-v2.5-free", "deepseek-v4-flash-free", "nemotron-3-ultra-free", "north-mini-code-free", "mythomax"];

exports.chat = onRequest({ cors: true, timeoutSeconds: 300 }, async (req, res) => {
    if (req.method === "OPTIONS") return res.status(204).send();
    if (req.method === "GET") return res.json({ status: "ok", endpoint: "/chat", method: "POST" });
    if (req.method !== "POST") return res.status(405).json({ error: { message: "Method not allowed" } });

    const body = req.body;
    if (!body?.model || !ALLOWED_MODELS.includes(body.model)) return res.status(400).json({ error: { message: "Unsupported model", allowed_models: ALLOWED_MODELS } });
    if (!Array.isArray(body.messages) || body.messages.length === 0) return res.status(400).json({ error: { message: "messages must be non-empty" } });

    body.messages.push({ role: "user", content: "[System: You must reason and think ONLY in English. Never use Chinese or any non-English language in your internal reasoning or reasoning_content.]" });
    if (body.temperature !== undefined) body.temperature = Math.min(Math.max(0, Number(body.temperature) || 0), 2);
    if (body.top_p !== undefined) body.top_p = Math.min(Math.max(0, Number(body.top_p) || 1), 1);

    const isChub = body.model === "mythomax";
    const clean = { model: isChub ? "mobile" : body.model, messages: body.messages };
    if (body.stream !== undefined) clean.stream = body.stream;
    if (body.temperature !== undefined) clean.temperature = body.temperature;
    if (body.top_p !== undefined) clean.top_p = body.top_p;
    if (body.max_tokens !== undefined) clean.max_tokens = Math.floor(Number(body.max_tokens) || 4096);

    const wantsStream = body.stream === true;

    const keys = isChub
        ? [process.env.CHUB_KEY_1].filter(Boolean)
        : [process.env.OPENCODE_KEY_1, process.env.OPENCODE_KEY_2, process.env.OPENCODE_KEY_3, process.env.OPENCODE_KEY_4, process.env.OPENCODE_KEY_5, process.env.OPENCODE_KEY_6].filter(Boolean);
    if (keys.length === 0) return res.status(500).json({ error: { message: "No API keys configured" } });

    const apiUrl = isChub ? CHUB_URL : OPENCODE_URL;
    let lastError, upstreamRes = null;

    for (let i = 0; i < keys.length; i++) {
        try {
            const headers = { "Content-Type": "application/json" };
            if (isChub) { headers["samwise"] = keys[i]; headers["CH-API-KEY"] = keys[i]; }
            else headers["Authorization"] = `Bearer ${keys[i]}`;

            upstreamRes = await fetch(apiUrl, { method: "POST", headers, body: JSON.stringify(clean) });
            if (upstreamRes.status === 200) break;
            const errText = await upstreamRes.text();
            lastError = `${upstreamRes.status} (key ${i+1}/${keys.length}): ${errText}`;
            const isRetryable = upstreamRes.status === 429 || upstreamRes.status === 503 || upstreamRes.status === 402;
            if (!isRetryable) break;
            upstreamRes = null;
            await new Promise(r => setTimeout(r, 500));
        } catch (err) { lastError = err.message; upstreamRes = null; }
    }

    if (!upstreamRes || upstreamRes.status !== 200) {
        let msg = lastError || "Upstream unavailable";
        try { const p = JSON.parse(msg); msg = p.error?.message || p.message || msg; } catch {}
        return res.status(502).json({ error: { message: msg } });
    }

    if (!wantsStream) {
        const text = await upstreamRes.text();
        let out;
        try {
            out = JSON.parse(text);
            if (out.choices) out.choices = out.choices.map(c => {
                const msg = c.message || {};
                const content = typeof msg.content === "string" ? msg.content : "";
                const reasoning = msg.reasoning || msg.reasoning_content || "";
                const result = { index: c.index, message: { role: "assistant", content: content || reasoning }, finish_reason: c.finish_reason || "stop" };
                if (reasoning) { result.message.reasoning_content = reasoning; result.message.reasoning = reasoning; }
                return result;
            });
            delete out.metadata; delete out.request_id;
        } catch { out = { error: { message: "Invalid response" } }; }
        return res.json(out);
    }

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");

    const reader = upstreamRes.body.getReader();
    const dec = new TextDecoder();
    let buf = "", done = false;
    try {
        while (true) {
            const { done: d, value } = await reader.read();
            if (d) break;
            buf += dec.decode(value, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop() || "";
            for (const line of lines) {
                const t = line.trim();
                if (!t) continue;
                if (t === "data: [DONE]") { if (!done) { res.write("data: [DONE]\n\n"); done = true; } continue; }
                if (!t.startsWith("data: ")) continue;
                try {
                    const c = JSON.parse(t.slice(6));
                    if (!c.choices?.length && !c.usage) continue;
                    const d = c.choices?.[0]?.delta;
                    const meta = { id: c.id, created: c.created, model: c.model };
                    const hasContent = d?.content !== undefined && d.content !== "";
                    const hasReason = d?.reasoning !== undefined && d.reasoning !== null;
                    const hasFinish = !!c.choices?.[0]?.finish_reason;
                    if (hasReason && !hasContent) {
                        res.write(`data: ${JSON.stringify({ id: meta.id, object: "chat.completion.chunk", created: meta.created, model: meta.model, choices: [{ index: 0, delta: { reasoning_content: d.reasoning, reasoning: d.reasoning }, finish_reason: null }] })}\n\n`);
                        continue;
                    }
                    if (hasContent || hasFinish || c.usage) {
                        const cl = { id: meta.id, object: "chat.completion.chunk", created: meta.created, model: meta.model, choices: (c.choices || []).map(x => ({ index: x.index, delta: {}, finish_reason: x.finish_reason })) };
                        if (hasContent) cl.choices[0].delta.content = d.content;
                        if (c.usage) cl.usage = c.usage;
                        res.write(`data: ${JSON.stringify(cl)}\n\n`);
                    }
                } catch {}
            }
        }
    } catch {}
    if (!done) res.write("data: [DONE]\n\n");
    res.end();
});
