"""
Ask natural-language questions about your AI usage. This script:
  1. Connects to the SigNoz MCP server (tools: metrics, alerts, dashboards, etc.)
  2. Converts its tool list into OpenAI-style function schemas
  3. Sends your question + those tools to Gemini, THROUGH our own gateway
     proxy (so this agent's own usage gets tracked too)
  4. If Gemini wants to call a SigNoz tool, executes it via MCP and feeds
     the real result back to Gemini for a final answer

Usage:
    python usage_agent.py
    (then type questions at the prompt, Ctrl+C to quit)

Requires env vars:
    SIGNOZ_MCP_URL      e.g. http://localhost:8000/mcp
    SIGNOZ_API_KEY      the Service Account API key from SigNoz UI
    PROXY_BASE          e.g. http://localhost:9000  (your gateway proxy)
"""
import asyncio
import json
import os

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client
from openai import OpenAI

SIGNOZ_MCP_URL = os.environ.get("SIGNOZ_MCP_URL", "http://localhost:8000/mcp")
SIGNOZ_API_KEY = os.environ.get("SIGNOZ_API_KEY", "")
PROXY_BASE = os.environ.get("PROXY_BASE", "http://localhost:9000")

llm = OpenAI(api_key="unused", base_url=f"{PROXY_BASE}/gemini/v1")


def mcp_tool_to_openai_schema(tool) -> dict:
    """Translate an MCP tool definition into the OpenAI function-calling shape."""
    return {
        "type": "function",
        "function": {
            "name": tool.name,
            "description": tool.description or "",
            "parameters": tool.inputSchema or {"type": "object", "properties": {}},
        },
    }


async def run_agent():
    async with streamablehttp_client(
        SIGNOZ_MCP_URL, headers={"SIGNOZ-API-KEY": SIGNOZ_API_KEY}
    ) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools_result = await session.list_tools()
            openai_tools = [mcp_tool_to_openai_schema(t) for t in tools_result.tools]
            print(f"Connected to SigNoz MCP -- {len(openai_tools)} tools available.\n")

            while True:
                question = input("Ask about your AI usage> ").strip()
                if not question:
                    continue

                messages = [
                    {
                        "role": "system",
                        "content": (
                            "You answer questions about AI usage/cost/tokens by "
                            "calling the available SigNoz tools to get real data. "
                            "Always call a tool rather than guessing numbers."
                        ),
                    },
                    {"role": "user", "content": question},
                ]

                # Keep calling tools until Gemini returns a final plain-text
                # answer (it may need several rounds -- e.g. list a metric,
                # then query it -- not just one).
                max_rounds = 6
                for _ in range(max_rounds):
                    response = llm.chat.completions.create(
                        model="gemini-flash-latest",
                        messages=messages,
                        tools=openai_tools,
                    )
                    msg = response.choices[0].message

                    if not msg.tool_calls:
                        print("\n" + (msg.content or "(empty response)") + "\n")
                        break

                    messages.append(msg)
                    for call in msg.tool_calls:
                        args = json.loads(call.function.arguments or "{}")
                        print(f"  -> calling SigNoz tool: {call.function.name}({args})")
                        result = await session.call_tool(call.function.name, args)
                        result_text = "".join(
                            part.text for part in result.content if hasattr(part, "text")
                        )
                        messages.append(
                            {
                                "role": "tool",
                                "tool_call_id": call.id,
                                "content": result_text,
                            }
                        )
                else:
                    print("\n(gave up after too many tool-call rounds -- try a more specific question)\n")


if __name__ == "__main__":
    try:
        asyncio.run(run_agent())
    except KeyboardInterrupt:
        print("\nGoodbye.")
