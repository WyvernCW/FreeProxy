const OPENCODE_URL = "https://opencode.ai/zen/v1/chat/completions";
const CHUB_URL = "https://gateway.chub.ai/v1/chat/completions";
const ALLOWED_MODELS = ["mimo-v2.5-free", "deepseek-v4-flash-free", "nemotron-3-ultra-free", "north-mini-code-free", "mythomax"];

export default async (request, context) => {
    if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: cors() });
    }
    if (request.method === "GET" && new URL(request.url).pathname === "/v1/models") {
        return json({ object: "list", data: ALLOWED_MODELS.map(id => ({ id, object: "model", owned_by: "opencode" })) });
    }
    if (request.method !== "POST") return json({ error: { message: "Method not allowed" } }, 405);

    let body;
    try { body = await request.json(); } catch { return json({ error: { message: "Invalid JSON" } }, 400); }
    if (!body?.model || !ALLOWED_MODELS.includes(body.model)) return json({ error: { message: "Unsupported model", allowed_models: ALLOWED_MODELS } }, 400);
    if (!Array.isArray(body.messages) || body.messages.length === 0) return json({ error: { message: "messages must be non-empty" } }, 400);

    body.messages.push({ role: "user", content: "[System: You must reason and think ONLY in English. Never use Chinese or any non-English language in your internal reasoning or reasoning_content.]" });
    if (body.temperature !== undefined) body.temperature = Math.min(Math.max(0, Number(body.temperature) || 0), 2);
    if (body.top_p !== undefined) body.top_p = Math.min(Math.max(0, Number(body.top_p) || 1), 1);

    const isChub = body.model === "mythomax";
    if (body.max_tokens !== undefined) body.max_tokens = Math.floor(Number(body.max_tokens) || 4096);
    else if (isChub) body.max_tokens = 4096;

    const clean = { model: isChub ? "mobile" : body.model, messages: body.messages };
    if (body.stream !== undefined) clean.stream = body.stream;
    if (body.temperature !== undefined) clean.temperature = body.temperature;
    if (body.top_p !== undefined) clean.top_p = body.top_p;
    if (body.max_tokens !== undefined) clean.max_tokens = body.max_tokens;

    const wantsStream = body.stream === true;

    if (isChub) {
        const keys = [process.env.CHUB_KEY_1, process.env.CHUB_KEY_2, process.env.CHUB_KEY_3, process.env.CHUB_KEY_4, process.env.CHUB_KEY_5, process.env.CHUB_KEY_6].filter(Boolean);
        if (keys.length === 0) return json({ error: { message: "No Chub API keys configured" } }, 500);
        let lastError, upstreamRes = null;
        for (let i = 0; i < keys.length; i++) {
            try {
                upstreamRes = await fetch(CHUB_URL, { method: "POST", headers: { "Content-Type": "application/json", "samwise": keys[i], "CH-API-KEY": keys[i] }, body: JSON.stringify(clean) });
                if (upstreamRes.status !== 429) break;
                lastError = `429 (key ${i+1}/${keys.length})`;
                upstreamRes = null;
                await new Promise(r => setTimeout(r, 500));
            } catch (err) { lastError = err.message; upstreamRes = null; }
        }
        if (!upstreamRes) return json({ error: { message: lastError || "Upstream unavailable" } }, 502);
        return forward(upstreamRes, wantsStream);
    }

    const keys = [process.env.OPENCODE_KEY_1, process.env.OPENCODE_KEY_2, process.env.OPENCODE_KEY_3, process.env.OPENCODE_KEY_4, process.env.OPENCODE_KEY_5, process.env.OPENCODE_KEY_6].filter(Boolean);
    if (keys.length === 0) return json({ error: { message: "No API keys configured" } }, 500);

    let lastError, upstreamRes = null;
    for (let i = 0; i < keys.length; i++) {
        try {
            upstreamRes = await fetch(OPENCODE_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${keys[i]}` },
                body: JSON.stringify(clean)
            });
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
        return json({ error: { message: msg } }, 502);
    }

    return forward(upstreamRes, wantsStream);
};

function cors() {
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
        "Access-Control-Max-Age": "86400"
    };
}

function json(data, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: { ...cors(), "Content-Type": "application/json" } });
}

function forward(upstreamRes, wantsStream) {
    if (!wantsStream) {
        return upstreamRes.text().then(text => {
            let out;
            try {
                out = JSON.parse(text);
                if (out.choices) {
                    out.choices = out.choices.map(c => {
                        const msg = c.message || {};
                        const content = typeof msg.content === "string" ? msg.content : "";
                        const reasoning = msg.reasoning || msg.reasoning_content || "";
                        const result = { index: c.index, message: { role: "assistant", content: content || reasoning }, finish_reason: c.finish_reason || "stop" };
                        if (reasoning) { result.message.reasoning_content = reasoning; result.message.reasoning = reasoning; }
                        return result;
                    });
                }
                delete out.metadata;
                delete out.request_id;
            } catch { out = { error: { message: "Invalid response" } }; }
            return new Response(JSON.stringify(out), { status: 200, headers: { ...cors(), "Content-Type": "application/json", "Cache-Control": "no-store" } });
        });
    }

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const enc = new TextEncoder();

    (async () => {
        let buf = "", done = false;
        const reader = upstreamRes.body.getReader();
        const dec = new TextDecoder();
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
                    if (t === "data: [DONE]") { if (!done) { writer.write(enc.encode("data: [DONE]\n\n")); done = true; } continue; }
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
                            writer.write(enc.encode(`data: ${JSON.stringify({ id: meta.id, object: "chat.completion.chunk", created: meta.created, model: meta.model, choices: [{ index: 0, delta: { reasoning_content: d.reasoning, reasoning: d.reasoning }, finish_reason: null }] })}\n\n`));
                            continue;
                        }
                        if (hasContent || hasFinish || c.usage) {
                            const cl = { id: meta.id, object: "chat.completion.chunk", created: meta.created, model: meta.model,
                                choices: (c.choices || []).map(x => ({ index: x.index, delta: {}, finish_reason: x.finish_reason })) };
                            if (hasContent) cl.choices[0].delta.content = d.content;
                            if (c.usage) cl.usage = c.usage;
                            writer.write(enc.encode(`data: ${JSON.stringify(cl)}\n\n`));
                        }
                    } catch {}
                }
            }
        } catch {}
        if (!done) writer.write(enc.encode("data: [DONE]\n\n"));
        writer.close();
    })();

    return new Response(readable, { status: 200, headers: { ...cors(), "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-cache, no-transform", "X-Accel-Buffering": "no" } });
}
