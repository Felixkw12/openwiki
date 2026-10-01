---
"openwiki": minor
---

Support Microsoft Entra ID authentication for OpenAI-compatible gateways with automatic token refresh during long runs. Set `OPENAI_COMPATIBLE_AUTH=entra-id` and configure `OPENAI_COMPATIBLE_ENTRA_SCOPE` for custom gateway audiences. Authentication uses Azure Identity without an API key or local proxy, for both Chat Completions and Responses, including streaming and tool calls.
