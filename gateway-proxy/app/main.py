import time

import httpx
from fastapi import FastAPI, Request, Response

from app.config import PROVIDER_URLS, API_KEYS, calc_cost
from app.telemetry import tracer, logger, record_usage

app = FastAPI(title="AI Gateway Proxy")
client = httpx.AsyncClient(timeout=120.0)


def build_headers(provider: str, incoming: dict) -> dict:
    """Swap in the real API key for each provider's expected auth header."""
    key = API_KEYS[provider]
    if provider == "anthropic":
        return {
            "x-api-key": key,
            "anthropic-version": incoming.get("anthropic-version", "2023-06-01"),
            "content-type": "application/json",
        }
    # openai, deepseek, and gemini (via its OpenAI-compat endpoint) all use Bearer auth
    return {"Authorization": f"Bearer {key}", "content-type": "application/json"}


def extract_usage(provider: str, resp_json: dict) -> tuple[int, int, int]:
    """Each provider names usage fields slightly differently. Returns
    (input_tokens, completion_tokens, total_tokens) -- total_tokens can
    exceed input+completion when a model bills hidden reasoning/thinking
    tokens (seen with Gemini's reasoning-capable models) that aren't
    broken out into the visible completion count."""
    usage = resp_json.get("usage", {})
    if provider == "anthropic":
        input_t = usage.get("input_tokens", 0)
        output_t = usage.get("output_tokens", 0)
        return input_t, output_t, input_t + output_t
    # openai, deepseek, and gemini's compat layer share the same field names
    input_t = usage.get("prompt_tokens", 0)
    output_t = usage.get("completion_tokens", 0)
    total_t = usage.get("total_tokens", input_t + output_t)
    return input_t, output_t, total_t


async def proxy_request(provider: str, request: Request) -> Response:
    body = await request.json()
    model = body.get("model", "unknown")
    project_tag = request.headers.get("x-project-tag", "untagged")

    with tracer.start_as_current_span("gen_ai.chat") as span:
        span.set_attribute("gen_ai.system", provider)
        span.set_attribute("gen_ai.request.model", model)
        span.set_attribute("gen_ai.request.project", project_tag)

        start = time.monotonic()
        status = "success"
        input_tokens = completion_tokens = billable_output = 0
        cost = 0.0

        try:
            upstream = await client.post(
                PROVIDER_URLS[provider],
                json=body,
                headers=build_headers(provider, dict(request.headers)),
            )
            upstream.raise_for_status()
            resp_json = upstream.json()

            input_tokens, completion_tokens, total_tokens = extract_usage(provider, resp_json)
            # billable output = everything beyond the input, since hidden
            # reasoning tokens are billed at the output rate but don't show
            # up in completion_tokens
            billable_output = max(total_tokens - input_tokens, completion_tokens)
            reasoning_tokens = max(billable_output - completion_tokens, 0)
            cost = calc_cost(model, input_tokens, billable_output)

            span.set_attribute("gen_ai.usage.input_tokens", input_tokens)
            span.set_attribute("gen_ai.usage.output_tokens", completion_tokens)
            if reasoning_tokens:
                span.set_attribute("gen_ai.usage.reasoning_tokens", reasoning_tokens)
            span.set_attribute("gen_ai.usage.total_tokens", total_tokens)
            span.set_attribute("gen_ai.usage.cost_usd", cost)
            span.set_attribute("gen_ai.response.latency_ms", int((time.monotonic() - start) * 1000))

            logger.info(
                f"provider={provider} model={model} project={project_tag} "
                f"tokens_in={input_tokens} tokens_out={completion_tokens} "
                f"reasoning_tokens={reasoning_tokens} cost_usd={cost}"
            )
            return Response(
                content=upstream.content,
                status_code=upstream.status_code,
                media_type="application/json",
                headers={
                    # The proxy is the one place that knows the real pricing
                    # table and does the reasoning-token correction -- any
                    # caller that wants cost/usage should read it from here
                    # instead of recomputing it (and risking disagreement
                    # with what SigNoz recorded for this same call).
                    "X-Gateway-Cost-Usd": str(cost),
                    "X-Gateway-Input-Tokens": str(input_tokens),
                    "X-Gateway-Output-Tokens": str(billable_output),
                    "X-Gateway-Total-Tokens": str(total_tokens),
                },
            )

        except httpx.HTTPStatusError as e:
            status = "error"
            span.set_attribute("error", True)
            span.set_attribute("error.status_code", e.response.status_code)
            logger.error(f"provider={provider} model={model} upstream_error={e.response.status_code}")
            return Response(content=e.response.content, status_code=e.response.status_code)

        except Exception as e:
            status = "error"
            span.set_attribute("error", True)
            span.record_exception(e)
            logger.error(f"provider={provider} model={model} error={str(e)}")
            return Response(content=str(e).encode(), status_code=502)

        finally:
            record_usage(provider, model, input_tokens, billable_output, cost, status)


# --- OpenAI / Anthropic / DeepSeek routes: parked for now, focusing on -----
# --- Gemini only. Uncomment when you're ready to bring them back in. -------
"""
@app.post("/openai/v1/chat/completions")
async def openai_proxy(request: Request):
    return await proxy_request("openai", request)


@app.post("/anthropic/v1/messages")
async def anthropic_proxy(request: Request):
    return await proxy_request("anthropic", request)


@app.post("/deepseek/v1/chat/completions")
async def deepseek_proxy(request: Request):
    return await proxy_request("deepseek", request)
"""


@app.post("/gemini/v1/chat/completions")
async def gemini_proxy(request: Request):
    return await proxy_request("gemini", request)


@app.get("/healthz")
async def healthz():
    return {"status": "ok"}
