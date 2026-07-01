export default {
    async fetch(request) {
        const url = new URL(request.url);
        const upstream = "https://janitor-pi.vercel.app";

        if (request.method === "OPTIONS") {
            return new Response(null, {
                status: 204,
                headers: {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                    "Access-Control-Allow-Headers": "Content-Type, Authorization",
                    "Access-Control-Max-Age": "86400"
                }
            });
        }

        const targetUrl = upstream + url.pathname + url.search;

        const headers = new Headers();
        request.headers.forEach((value, key) => {
            if (key.toLowerCase() !== "host") {
                headers.set(key, value);
            }
        });

        const upstreamReq = new Request(targetUrl, {
            method: request.method,
            headers,
            body: request.method !== "GET" && request.method !== "HEAD" ? request.body : undefined,
            redirect: "follow"
        });

        const upstreamRes = await fetch(upstreamReq);

        const responseHeaders = new Headers(upstreamRes.headers);
        responseHeaders.set("Access-Control-Allow-Origin", "*");
        responseHeaders.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        responseHeaders.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
        responseHeaders.delete("X-Content-Security-Policy");
        responseHeaders.delete("Content-Security-Policy");
        responseHeaders.delete("Strict-Transport-Security");
        responseHeaders.delete("X-Frame-Options");

        return new Response(upstreamRes.body, {
            status: upstreamRes.status,
            statusText: upstreamRes.statusText,
            headers: responseHeaders
        });
    }
};
