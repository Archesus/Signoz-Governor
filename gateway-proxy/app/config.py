import os
from pathlib import Path

from dotenv import load_dotenv

# Loads .env automatically from the project root (one level up from this
# file, in app/), regardless of what directory you happen to launch
# uvicorn from -- no more depending on the shell having run `source .env`
# first. This is the actual fix for the repeated "Illegal header value
# b'Bearer '" errors: the app was always relying on the shell's exported
# state, with no fallback of its own.
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

# --- Real provider endpoints -------------------------------------------------
PROVIDER_URLS = {
    "openai": "https://api.openai.com/v1/chat/completions",
    "anthropic": "https://api.anthropic.com/v1/messages",
    "deepseek": "https://api.deepseek.com/v1/chat/completions",
    # Gemini's official OpenAI-compatibility layer -- same request/response
    # shape as OpenAI, so it reuses the openai/deepseek handling as-is.
    "gemini": "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    "groq": "https://api.groq.com/openai/v1/chat/completions",
}

# --- Real API keys (set these in your environment, never hardcode) ----------
API_KEYS = {
    "openai": os.environ.get("OPENAI_API_KEY", ""),
    "anthropic": os.environ.get("ANTHROPIC_API_KEY", ""),
    "deepseek": os.environ.get("DEEPSEEK_API_KEY", ""),
    "gemini": os.environ.get("GEMINI_API_KEY", ""),
    "groq": os.environ.get("GROQ_API_KEY", ""),
}

# --- Pricing table: USD per 1K tokens (input, output) ------------------------
# Update these as providers change pricing -- this is the source of truth
# for every cost figure the proxy reports.
PRICING = {
    # OpenAI
    "gpt-4o": (0.0025, 0.010),
    "gpt-4o-mini": (0.00015, 0.0006),
    "gpt-4.1": (0.002, 0.008),
    # Anthropic
    "claude-sonnet-4-6": (0.003, 0.015),
    "claude-haiku-4-5-20251001": (0.0008, 0.004),
    "claude-opus-4-8": (0.015, 0.075),
    # DeepSeek
    "deepseek-chat": (0.00027, 0.0011),
    "deepseek-reasoner": (0.00055, 0.00219),
    # Gemini -- verify current rates at ai.google.dev/pricing before relying on these
    "gemini-3.5-flash": (0.0001, 0.0004),
    "gemini-3.5-pro": (0.00125, 0.005),
    # the alias actually in use (avoids pinned-version 404s) -- currently
    # Flash-tier pricing; re-check this if Google repoints the alias to a
    # different tier
    "gemini-flash-latest": (0.0001, 0.0004),
    "gemini-pro-latest": (0.00125, 0.005),
    # Groq temp prices
    "llama-3.3-70b-versatile": (0.00059, 0.00079),
}

DEFAULT_PRICING = (0.0, 0.0)  # unknown model -> cost reported as 0, not guessed

# --- OTel export target -------------------------------------------------------
# Point this at your SigNoz collector, e.g. http://<EC2_PUBLIC_IP>:4317
OTEL_ENDPOINT = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4317")

SERVICE_NAME = "ai-gateway-proxy"


def calc_cost(model: str, input_tokens: int, output_tokens: int) -> float:
    in_rate, out_rate = PRICING.get(model, DEFAULT_PRICING)
    return round((input_tokens / 1000) * in_rate + (output_tokens / 1000) * out_rate, 6)
