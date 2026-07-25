"""
Quick smoke test: sends one real request through the gateway proxy's
Gemini route and prints the response + where to look in SigNoz.

Usage:
    python test_gemini.py http://<PROXY_HOST>:9000
"""
import sys
from openai import OpenAI

proxy_base = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:9000"

client = OpenAI(
    api_key="unused",  # the proxy injects the real Gemini key server-side
    base_url=f"{proxy_base}/gemini/v1",
)

response = client.chat.completions.create(
    model="gemini-flash-latest",
    messages=[{"role": "user", "content": "Why is Christopher Nolan's movies so good?"}],
)

print("Response:", response.choices[0].message.content)
print("Usage:", response.usage)
print("\nNow check SigNoz -> Traces for a 'gen_ai.chat' span with gen_ai.system=gemini")
