const NETLIFY_URL = "https://janitor-pi.netlify.app";

export default async function handler(req, res) {
    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

    const url = new URL(req.url, `https://${req.headers.host}`);

    try {
        const upstreamRes = await fetch(`${NETLIFY_URL}${url.pathname}${url.search}`, {
            method: req.method,
            headers: {
                "Content-Type": req.headers["content-type"] || "application/json",
                "Accept": req.headers["accept"] || "*/*"
            },
            body: req.method !== "GET" && req.method !== "HEAD" ? await new Promise((resolve) => {
                let data = "";
                req.on("data", c => data += c);
                req.on("end", () => resolve(data || undefined));
            }) : undefined
        });

        res.writeHead(upstreamRes.status, {
            "Content-Type": upstreamRes.headers.get("Content-Type") || "application/json",
            "Cache-Control": "no-store",
            "Access-Control-Allow-Origin": "*"
        });

        const reader = upstreamRes.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
        }
        res.end();
    } catch (err) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: `Upstream unavailable: ${err.message}` } }));
    }
}
