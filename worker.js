const NETLIFY_URL = "https://janitor-pi.netlify.app";

const SECURITY = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
    "Access-Control-Max-Age": "86400"
};

export default {
    async fetch(request) {
        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: SECURITY });
        }

        const url = new URL(request.url);

        // Proxy everything to Netlify
        try {
            const upstreamRes = await fetch(`${NETLIFY_URL}${url.pathname}${url.search}`, {
                method: request.method,
                headers: {
                    "Content-Type": request.headers.get("Content-Type") || "application/json",
                    "Accept": request.headers.get("Accept") || "*/*"
                },
                body: request.method !== "GET" && request.method !== "HEAD" ? await request.text() : undefined
            });

            const respHeaders = { ...SECURITY };
            const ct = upstreamRes.headers.get("Content-Type");
            if (ct) respHeaders["Content-Type"] = ct;
            const cl = upstreamRes.headers.get("Content-Length");
            if (cl) respHeaders["Content-Length"] = cl;
            const cc = upstreamRes.headers.get("Cache-Control");
            if (cc) respHeaders["Cache-Control"] = cc;

            return new Response(upstreamRes.body, { status: upstreamRes.status, headers: respHeaders });
        } catch (err) {
            return new Response(JSON.stringify({ error: { message: `Upstream unavailable: ${err.message}` } }), {
                status: 502, headers: { ...SECURITY, "Content-Type": "application/json" }
            });
        }
    }
};
