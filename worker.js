export default {
    async fetch(request) {
        const url = new URL(request.url);
        const upstream = "https://janitor-pi.vercel.app";

        const CORS_HEADERS = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With, http-referer, samwise, CH-API-KEY, x-title",
            "Access-Control-Max-Age": "86400"
        };

        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        const targetUrl = upstream + url.pathname + url.search;

        const headers = new Headers();
        request.headers.forEach((value, key) => {
            if (key.toLowerCase() !== "host") {
                headers.set(key, value);
            }
        });

        const upstreamRes = await fetch(new Request(targetUrl, {
            method: request.method,
            headers,
            body: request.method !== "GET" && request.method !== "HEAD" ? request.body : undefined,
            redirect: "follow"
        }));

        const responseHeaders = new Headers(upstreamRes.headers);
        Object.entries(CORS_HEADERS).forEach(([k, v]) => responseHeaders.set(k, v));
        responseHeaders.delete("Content-Security-Policy");
        responseHeaders.delete("X-Content-Security-Policy");
        responseHeaders.delete("Strict-Transport-Security");
        responseHeaders.delete("X-Frame-Options");

        return new Response(upstreamRes.body, {
            status: upstreamRes.status,
            statusText: upstreamRes.statusText,
            headers: responseHeaders
        });
    }
};
