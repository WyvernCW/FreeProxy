const VAL_TOWN_URL = "https://mochibun--ca373aca773e11f184a41607ee4eb77e.web.val.run";

const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
    "Access-Control-Max-Age": "86400"
};

export default {
    async fetch(request) {
        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: CORS });
        }

        const headers = { "Content-Type": "application/json" };
        const auth = request.headers.get("Authorization");
        if (auth) headers["Authorization"] = auth;

        try {
            const body = await request.text();
            const upstreamRes = await fetch(VAL_TOWN_URL, { method: "POST", headers, body });

            const respHeaders = { ...CORS };
            const ct = upstreamRes.headers.get("Content-Type");
            if (ct) respHeaders["Content-Type"] = ct;

            return new Response(upstreamRes.body, { status: upstreamRes.status, headers: respHeaders });
        } catch (err) {
            return new Response(JSON.stringify({ error: { message: err.message } }), {
                status: 502, headers: { ...CORS, "Content-Type": "application/json" }
            });
        }
    }
};
