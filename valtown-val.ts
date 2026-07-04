// Janitor-Pi Proxy — Val Town

const OPENCODE_URL = "https://opencode.ai/zen/v1/chat/completions";
const CHUB_URL = "https://gateway.chub.ai/v1/chat/completions";
const ALLOWED_MODELS = ["mimo-v2.5-free", "deepseek-v4-flash-free", "nemotron-3-ultra-free", "north-mini-code-free", "mythomax"];

const KEYS = [
    Deno.env.get("OPENCODE_KEY_1"), Deno.env.get("OPENCODE_KEY_2"), Deno.env.get("OPENCODE_KEY_3"),
    Deno.env.get("OPENCODE_KEY_4"), Deno.env.get("OPENCODE_KEY_5"), Deno.env.get("OPENCODE_KEY_6"),
    Deno.env.get("OPENCODE_KEY_7"), Deno.env.get("OPENCODE_KEY_8"), Deno.env.get("OPENCODE_KEY_9")
].filter(Boolean);

const CHUB_KEYS = [Deno.env.get("CHUB_KEY_1"), Deno.env.get("CHUB_KEY_2")].filter(Boolean);

const CORS: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
    "Access-Control-Max-Age": "86400"
};

export default async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (req.method === "GET") return json({ status: "ok", endpoint: "/v1/chat/completions", method: "POST" });
    if (req.method !== "POST") return json({ error: { message: "Method not allowed" } }, 405);

    let body: any;
    try { body = await req.json(); } catch { return json({ error: { message: "Invalid JSON" } }, 400); }
    if (!body?.model || !ALLOWED_MODELS.includes(body.model)) return json({ error: { message: "Unsupported model", allowed_models: ALLOWED_MODELS } }, 400);
    if (!Array.isArray(body.messages) || body.messages.length === 0) return json({ error: { message: "messages must be non-empty" } }, 400);

    body.messages.push({ role: "user", content: "[System: You must reason and think ONLY in English. Never use Chinese or any non-English language in your internal reasoning or reasoning_content.]" });
    if (body.temperature !== undefined) body.temperature = Math.min(Math.max(0, Number(body.temperature) || 0), 2);
    if (body.top_p !== undefined) body.top_p = Math.min(Math.max(0, Number(body.top_p) || 1), 1);

    const isChub = body.model === "mythomax";
    const clean: any = { model: isChub ? "mobile" : body.model, messages: body.messages };
    if (body.stream !== undefined) clean.stream = body.stream;
    if (body.temperature !== undefined) clean.temperature = body.temperature;
    if (body.top_p !== undefined) clean.top_p = body.top_p;
    clean.max_tokens = Math.floor(Number(body.max_tokens) || 32768);

    const apiUrl = isChub ? CHUB_URL : OPENCODE_URL;
    const keys = isChub ? CHUB_KEYS : KEYS;
    if (keys.length === 0) return json({ error: { message: "No API keys configured" } }, 500);

    let lastError: string | null = null;
    let upstreamRes: Response | null = null;
    for (let i = 0; i < keys.length; i++) {
        try {
            const headers: Record<string, string> = { "Content-Type": "application/json" };
            if (isChub) { headers["samwise"] = keys[i]; headers["CH-API-KEY"] = keys[i]; }
            else headers["Authorization"] = `Bearer ${keys[i]}`;
            upstreamRes = await fetch(apiUrl, { method: "POST", headers, body: JSON.stringify(clean) });
            if (upstreamRes.status === 200) break;
            const errText = await upstreamRes.text();
            lastError = `${upstreamRes.status} (key ${i + 1}/${keys.length}): ${errText}`;
            if (upstreamRes.status !== 429 && upstreamRes.status !== 503 && upstreamRes.status !== 402) break;
            upstreamRes = null;
            await new Promise(r => setTimeout(r, 300));
        } catch (err) { lastError = (err as Error).message; upstreamRes = null; }
    }

    if (!upstreamRes || upstreamRes.status !== 200) {
        let msg = lastError || "Upstream unavailable";
        try { const p = JSON.parse(msg); msg = p.error?.message || p.message || msg; } catch {}
        return json({ error: { message: msg } }, 502);
    }

    if (body.stream) {
        const stream = new ReadableStream({
            async start(controller) {
                const reader = upstreamRes!.body!.getReader();
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
                            if (t === "data: [DONE]") {
                                if (!done) { controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); done = true; }
                                continue;
                            }
                            if (!t.startsWith("data: ")) continue;
                            try {
                                const c = JSON.parse(t.slice(6));
                                if (!c.choices?.length && !c.usage) continue;
                                const d = c.choices?.[0]?.delta;
                                const meta = { id: c.id, created: c.created, model: c.model };
                                const hasContent = d?.content !== undefined && d.content !== null && d.content !== "";
                                const reasonText = d?.reasoning_content ?? d?.reasoning ?? null;
                                const hasReason = reasonText !== undefined && reasonText !== null && reasonText !== "";
                                const hasFinish = !!c.choices?.[0]?.finish_reason;
                                if (hasReason && !hasContent) {
                                    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: meta.id, object: "chat.completion.chunk", created: meta.created, model: meta.model, choices: [{ index: 0, delta: { reasoning_content: reasonText, reasoning: reasonText }, finish_reason: null }] })}\n\n`));
                                    continue;
                                }
                                if (hasContent || hasFinish || c.usage) {
                                    const cl: any = { id: meta.id, object: "chat.completion.chunk", created: meta.created, model: meta.model, choices: (c.choices || []).map((x: any) => ({ index: x.index, delta: {}, finish_reason: x.finish_reason })) };
                                    if (hasContent) cl.choices[0].delta.content = d.content;
                                    if (c.usage) cl.usage = c.usage;
                                    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(cl)}\n\n`));
                                }
                            } catch {}
                        }
                    }
                } catch (e) {}
                if (!done) controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
                controller.close();
            }
        });
        return new Response(stream, {
            status: 200,
            headers: { ...CORS, "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-cache, no-transform", "X-Accel-Buffering": "no" }
        });
    }

    const text = await upstreamRes.text();
    return new Response(text, { status: 200, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" } });
};

function json(data: any, status = 200): Response {
    return new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
